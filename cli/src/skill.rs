//! `trama skill`: ships `skills/trama-cli/SKILL.md` inside the binary and installs it where a coding
//! agent loads skills, so an agent learns the CLI without any repository checkout.

use std::path::PathBuf;

use clap::ArgMatches;
use serde_json::json;

use crate::Ctx;
use crate::config::home_dir;
use crate::error::{CliError, Result};
use crate::output;

pub const SKILL_MD: &str = include_str!("../../skills/trama-cli/SKILL.md");
const NAME: &str = "trama-cli";

fn skills_dir(m: &ArgMatches) -> Result<PathBuf> {
    if let Some(dir) = m.get_one::<String>("dir") {
        return Ok(PathBuf::from(dir));
    }
    let base = match m.get_one::<String>("scope").map(String::as_str) {
        Some("project") => std::env::current_dir()?,
        _ => home_dir(),
    };
    let folder = match m.get_one::<String>("target").map(String::as_str) {
        Some("agents") => ".agents",
        _ => ".claude",
    };
    Ok(base.join(folder).join("skills"))
}

pub fn run(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    match m.subcommand() {
        Some(("show", _)) => output::emit(SKILL_MD),
        Some(("path", sm)) => output::emit(&skills_dir(sm)?.join(NAME).join("SKILL.md").display().to_string()),
        Some(("install", sm)) => {
            let dir = skills_dir(sm)?.join(NAME);
            let file = dir.join("SKILL.md");
            if file.exists() && !sm.get_flag("force") && std::fs::read_to_string(&file).ok().as_deref() != Some(SKILL_MD) {
                return Err(CliError::usage(format!("{} already exists and differs", file.display())).hint("Use --force to overwrite it."));
            }
            std::fs::create_dir_all(&dir)?;
            std::fs::write(&file, SKILL_MD)?;
            output::print(&json!({ "installed": file, "bytes": SKILL_MD.len() }), &ctx.fmt);
        }
        _ => unreachable!("subcommand is required"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_skill_is_well_formed() {
        let md = SKILL_MD.replace("\r\n", "\n"); // a Windows checkout may have converted line endings
        assert!(md.starts_with("---\nname: trama-cli\n"));
        let end = md[4..].find("\n---\n").expect("frontmatter is closed");
        let front = &md[4..4 + end];
        assert!(front.contains("description:"));
    }
}
