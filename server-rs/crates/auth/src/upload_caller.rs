//! Who is saving text, for the uploads it embeds: the port of `server/src/auth/upload-caller.ts`
//! (`UploadCaller` of `uploads/upload-rules.ts`).
//!
//! The guard sets it for every `/w/{slug}` route, next to the member access, so a description or
//! comment save can check the files it references without the handler passing the caller down.
//! Like [`crate::member_access`], it is a tokio task-local: read it before `tokio::spawn`.

use std::future::Future;
use std::sync::Arc;

use trama_contracts::common::ActorRef;
use trama_contracts::roles::Role;

/// The caller of a workspace route, as the upload rules need it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadCaller {
    /// The acting user or agent.
    pub actor: ActorRef,
    /// The membership's role id (`member` for agents).
    pub role: Role,
    /// Set for a `custom` API token (possibly empty); `None` for sessions and read, write or
    /// admin tokens.
    pub permissions: Option<Vec<String>>,
}

tokio::task_local! {
    static UPLOAD_CALLER: Option<Arc<UploadCaller>>;
}

/// The caller of the workspace route being handled; `None` outside one.
#[must_use]
pub fn current_upload_caller() -> Option<Arc<UploadCaller>> {
    UPLOAD_CALLER.try_with(Clone::clone).ok().flatten()
}

/// Runs `fut` with `caller` as the current upload caller.
pub async fn with_upload_caller<F: Future>(caller: Option<Arc<UploadCaller>>, fut: F) -> F::Output {
    UPLOAD_CALLER.scope(caller, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn is_scoped_to_the_future() {
        assert!(current_upload_caller().is_none());
        let caller = UploadCaller {
            actor: ActorRef::user("u_1"),
            role: "member".into(),
            permissions: Some(vec!["artifacts:write".into()]),
        };
        let seen = with_upload_caller(Some(Arc::new(caller.clone())), async {
            current_upload_caller().map(|c| (*c).clone())
        })
        .await;
        assert_eq!(seen, Some(caller));
        assert!(current_upload_caller().is_none());
    }
}
