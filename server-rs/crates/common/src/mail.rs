//! Outgoing email over SMTP, the port of `server/src/mail/mail.service.ts`.
//!
//! Configure with `SMTP_URL` (`smtp://user:pass@smtp.example.com:587`, STARTTLS when the
//! server offers it; `smtps://…` for implicit TLS) and optionally `MAIL_FROM`
//! (`Trama <no-reply@example.com>`). Without `SMTP_URL` nothing is sent: [`Mailer::send`]
//! returns `false` and callers show the link in the UI instead.
//!
//! As with nodemailer, the URL's query can set `secure=true` (implicit TLS),
//! `requireTLS=true`, `ignoreTLS=true` and `tls.rejectUnauthorized=false`; the port defaults to
//! 465 with implicit TLS and 587 otherwise.
//!
//! Handlers get the process's mailer with [`Mailer::of`]. Tests register
//! [`Mailer::capture`] on the state with `AppState::with_extension` and read what was sent.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use lettre::message::header::ContentType;
use lettre::message::{Mailbox, Mailboxes, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use trama_core::config::MailConfig;
use trama_core::{AppState, Config};
use url::Url;

/// One message. Only these fields are sent: nothing a caller adds elsewhere reaches SMTP.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mail {
    /// Recipient address (`a@b.dev`, `Name <a@b.dev>` or a comma-separated list).
    pub to: String,
    /// Subject line.
    pub subject: String,
    /// Plain-text body.
    pub text: String,
    /// HTML alternative.
    pub html: Option<String>,
}

/// A message as a capturing mailer recorded it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SentMail {
    /// The configured sender.
    pub from: String,
    /// The message.
    pub mail: Mail,
}

#[derive(Clone)]
enum Transport {
    Off,
    Smtp(AsyncSmtpTransport<Tokio1Executor>),
    Capture(Arc<Mutex<Vec<SentMail>>>),
}

/// Sends email. Cheap to clone (the SMTP connection pool is shared).
#[derive(Clone)]
pub struct Mailer {
    transport: Transport,
    from: String,
}

impl std::fmt::Debug for Mailer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self.transport {
            Transport::Off => "off",
            Transport::Smtp(_) => "smtp",
            Transport::Capture(_) => "capture",
        };
        f.debug_struct("Mailer").field("transport", &kind).field("from", &self.from).finish()
    }
}

impl Mailer {
    /// The mailer `config` describes. An unusable `SMTP_URL` is logged and disables sending.
    /// Call inside a Tokio runtime (the SMTP pool starts a cleanup task).
    #[must_use]
    pub fn from_config(config: &MailConfig) -> Self {
        let from = config.from.clone();
        let Some(url) = &config.smtp_url else {
            static LOGGED: AtomicBool = AtomicBool::new(false);
            if !LOGGED.swap(true, Ordering::Relaxed) {
                tracing::info!("SMTP_URL is not set: emails are not sent");
            }
            return Self { transport: Transport::Off, from };
        };
        match smtp_transport(url.expose()) {
            Ok(transport) => Self { transport: Transport::Smtp(transport), from },
            Err(err) => {
                tracing::warn!("SMTP_URL is not usable ({err}): emails are not sent");
                Self { transport: Transport::Off, from }
            }
        }
    }

    /// A mailer that records messages instead of sending them (tests).
    #[must_use]
    pub fn capture(config: &Config) -> Self {
        Self { transport: Transport::Capture(Arc::default()), from: config.mail.from.clone() }
    }

    /// The mailer registered on `state` at startup, else one built from its configuration.
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        state.extension::<Self>().cloned().unwrap_or_else(|| Self::from_config(&state.config.mail))
    }

    /// Whether messages are sent at all.
    #[must_use]
    pub fn enabled(&self) -> bool {
        !matches!(self.transport, Transport::Off)
    }

    /// What a capturing mailer recorded (empty for the others).
    #[must_use]
    pub fn sent(&self) -> Vec<SentMail> {
        match &self.transport {
            Transport::Capture(sent) => sent.lock().unwrap_or_else(PoisonError::into_inner).clone(),
            _ => Vec::new(),
        }
    }

    /// `true` when the SMTP server accepted the message. Never fails: problems are logged.
    pub async fn send(&self, mail: Mail) -> bool {
        match &self.transport {
            Transport::Off => false,
            Transport::Capture(sent) => {
                sent.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(SentMail { from: self.from.clone(), mail });
                true
            }
            Transport::Smtp(smtp) => {
                let result = match build_message(&self.from, &mail) {
                    Ok(message) => smtp.send(message).await.map(|_| ()).map_err(|e| e.to_string()),
                    Err(e) => Err(e),
                };
                match result {
                    Ok(()) => true,
                    Err(e) => {
                        tracing::warn!("Could not send \"{}\": {e}", mail.subject);
                        false
                    }
                }
            }
        }
    }
}

/// The MIME message for `mail`: From, To, Subject and the text body, with an HTML alternative
/// when there is one.
///
/// # Errors
///
/// A message when an address cannot be parsed.
pub fn build_message(from: &str, mail: &Mail) -> Result<Message, String> {
    let from: Mailbox = from.parse().map_err(|e| format!("invalid sender {from:?}: {e}"))?;
    let to: Mailboxes = mail.to.parse().map_err(|e| format!("invalid recipient: {e}"))?;
    let mut builder = Message::builder().from(from).subject(mail.subject.clone());
    for mailbox in to {
        builder = builder.to(mailbox);
    }
    let message = match &mail.html {
        Some(html) => {
            builder.multipart(MultiPart::alternative_plain_html(mail.text.clone(), html.clone()))
        }
        None => builder.header(ContentType::TEXT_PLAIN).body(mail.text.clone()),
    };
    message.map_err(|e| e.to_string())
}

/// Percent-decodes a URL user or password.
fn decode(raw: &str) -> String {
    percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned()
}

fn smtp_transport(raw: &str) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let url = Url::parse(raw).map_err(|e| e.to_string())?;
    let query = |name: &str| {
        url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.eq_ignore_ascii_case("true"))
    };
    let secure = match url.scheme() {
        "smtps" => true,
        "smtp" => query("secure").unwrap_or(false),
        other => return Err(format!("unsupported scheme {other}:")),
    };
    let host = url.host_str().unwrap_or("localhost").trim_matches(['[', ']']).to_owned();
    let port = url.port().unwrap_or(if secure { 465 } else { 587 });
    let mut tls_params = TlsParameters::builder(host.clone());
    if query("tls.rejectUnauthorized") == Some(false) {
        tls_params = tls_params.dangerous_accept_invalid_certs(true);
    }
    let tls_params = tls_params.build().map_err(|e| e.to_string())?;
    let tls = if secure {
        Tls::Wrapper(tls_params)
    } else if query("ignoreTLS") == Some(true) {
        Tls::None
    } else if query("requireTLS") == Some(true) {
        Tls::Required(tls_params)
    } else {
        Tls::Opportunistic(tls_params)
    };
    let mut builder =
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host).port(port).tls(tls);
    if !url.username().is_empty() {
        builder = builder.credentials(Credentials::new(
            decode(url.username()),
            decode(url.password().unwrap_or_default()),
        ));
    }
    Ok(builder.build())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(html: Option<&str>) -> Mail {
        Mail {
            to: "recipient@example.com".into(),
            subject: "Invitation".into(),
            text: "Join Trama".into(),
            html: html.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn is_off_without_smtp_url() {
        let mailer = Mailer::from_config(&Config::from_vars(&[]).mail);
        assert!(!mailer.enabled());
        assert!(!mailer.send(mail(None)).await);
    }

    #[tokio::test]
    async fn builds_transports_from_urls() {
        for url in [
            "smtp://localhost",
            "smtp://user:p%40ss@smtp.example.com:2525",
            "smtps://user:pass@smtp.example.com",
            "smtp://mail?requireTLS=true",
            "smtp://mail?ignoreTLS=true&tls.rejectUnauthorized=false",
        ] {
            assert!(smtp_transport(url).is_ok(), "{url}");
        }
        assert!(smtp_transport("http://mail").is_err());
        assert!(smtp_transport("not a url").is_err());
        let mailer = Mailer::from_config(
            &Config::from_vars(&[
                ("SMTP_URL", "smtp://localhost"),
                ("MAIL_FROM", "Trama <mail@example.com>"),
            ])
            .mail,
        );
        assert!(mailer.enabled());
    }

    #[test]
    fn decodes_credentials() {
        assert_eq!(decode("p%40ss"), "p@ss");
        assert_eq!(decode("a+b"), "a+b");
    }

    #[test]
    fn sends_only_the_explicit_fields() {
        let message =
            build_message("Trama <mail@example.com>", &mail(Some("<p>Join Trama</p>"))).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("From: Trama <mail@example.com>"), "{raw}");
        assert!(raw.contains("To: recipient@example.com"), "{raw}");
        assert!(raw.contains("Subject: Invitation"), "{raw}");
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("Join Trama") && raw.contains("<p>Join Trama</p>"), "{raw}");
        assert!(!raw.contains("attachment"), "{raw}");

        let plain = build_message("Trama <no-reply@localhost>", &mail(None)).unwrap();
        let raw = String::from_utf8(plain.formatted()).unwrap();
        assert!(raw.contains("Content-Type: text/plain"), "{raw}");
        assert!(!raw.contains("multipart"), "{raw}");
    }

    #[test]
    fn refuses_bad_addresses() {
        assert!(build_message("not an address", &mail(None)).is_err());
        let bad = Mail { to: "nobody".into(), ..mail(None) };
        assert!(build_message("Trama <a@b.dev>", &bad).is_err());
    }

    #[tokio::test]
    async fn capture_records_messages() {
        let config = Config::from_vars(&[("MAIL_FROM", "Trama <mail@example.com>")]);
        let mailer = Mailer::capture(&config);
        let state = AppState::new(sea_orm::DatabaseConnection::default(), config)
            .with_extension(mailer.clone());
        assert!(Mailer::of(&state).send(mail(None)).await);
        let sent = mailer.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].from, "Trama <mail@example.com>");
        assert_eq!(sent[0].mail, mail(None));
    }
}
