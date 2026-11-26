//! The query string of the insights routes.

use trama_contracts::insights::INSIGHT_RANGES;
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::validation::Checks;
use utoipa::IntoParams;

/// `InsightsQueryDto`: every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct InsightsQuery {
    /// Range in days: 7, 30 (default) or 90.
    #[param(value_type = Option<u32>)]
    pub days: Option<u32>,
    /// Only this project's issues.
    #[param(rename = "projectId")]
    pub project_id: Option<String>,
    /// In-flight issues idle for this many days are stale: 1..=90, default 7.
    #[param(rename = "staleDays", value_type = Option<u32>, minimum = 1, maximum = 90)]
    pub stale_days: Option<u32>,
    /// Items per signal: 1..=500, default 25 (100 on a single signal).
    #[param(value_type = Option<u32>, minimum = 1, maximum = 500)]
    pub limit: Option<u32>,
}

impl InsightsQuery {
    /// Reads the raw query string the way Express (`querystring`), class-transformer and
    /// class-validator do: a repeated key is an array (not a string), numbers go through
    /// `Number()`, unknown keys are dropped.
    ///
    /// # Errors
    ///
    /// 400 with every class-validator message, in declaration order.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let mut values: Vec<(String, Vec<String>)> = Vec::new();
        for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
            match values.iter_mut().find(|(k, _)| *k == key) {
                Some((_, list)) => list.push(value.into_owned()),
                None => values.push((key.into_owned(), vec![value.into_owned()])),
            }
        }
        let get = |name: &str| values.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_slice());
        // `@Type(() => Number)`: a repeated key is an array, which is `NaN`
        let number = |name: &str| {
            get(name).map(|list| match list {
                [one] => js_number(one).unwrap_or(f64::NAN),
                _ => f64::NAN,
            })
        };
        let mut checks = Checks::new();

        // @IsOptional() @Type(() => Number) @IsIn(INSIGHT_RANGES)
        let days = number("days");
        if let Some(n) = days {
            let allowed: Vec<String> = INSIGHT_RANGES.iter().map(ToString::to_string).collect();
            checks.check(
                INSIGHT_RANGES.iter().any(|r| (f64::from(*r) - n).abs() == 0.0),
                format!("days must be one of the following values: {}", allowed.join(", ")),
            );
        }

        // @IsOptional() @IsString()
        let project_id = get("projectId").filter(|list| {
            checks.check(list.len() == 1, "projectId must be a string");
            list.len() == 1
        });

        // @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90), run bottom-up
        let stale_days = number("staleDays");
        if let Some(n) = stale_days {
            checks
                .check(n <= 90.0, "staleDays must not be greater than 90")
                .check(n >= 1.0, "staleDays must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "staleDays must be an integer number");
        }

        // @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500), run bottom-up
        let limit = number("limit");
        if let Some(n) = limit {
            checks
                .check(n <= 500.0, "limit must not be greater than 500")
                .check(n >= 1.0, "limit must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "limit must be an integer number");
        }
        checks.finish()?;

        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let whole = |n: Option<f64>| n.map(|n| n as u32);
        Ok(Self {
            days: whole(days),
            project_id: project_id.map(|list| list[0].clone()),
            stale_days: whole(stale_days),
            limit: whole(limit),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(raw: &str) -> String {
        let err = InsightsQuery::parse(Some(raw)).unwrap_err().to_string();
        err.trim_start_matches("400 Bad Request: ").to_owned()
    }

    #[test]
    fn reads_every_field() {
        let q =
            InsightsQuery::parse(Some("days=7&projectId=pr_1&staleDays=3&limit=0x10&x=1")).unwrap();
        assert_eq!(
            q,
            InsightsQuery {
                days: Some(7),
                project_id: Some("pr_1".into()),
                stale_days: Some(3),
                limit: Some(16)
            }
        );
        assert_eq!(InsightsQuery::parse(None).unwrap(), InsightsQuery::default());
        assert_eq!(
            InsightsQuery::parse(Some("projectId=")).unwrap().project_id.as_deref(),
            Some("")
        );
    }

    #[test]
    fn validates_like_class_validator() {
        let days = "days must be one of the following values: 7, 30, 90";
        assert_eq!(message("days=14"), days);
        assert_eq!(message("days=abc"), days);
        assert_eq!(message("days=7&days=30"), days);
        assert_eq!(message("projectId=a&projectId=b"), "projectId must be a string");
        assert_eq!(message("staleDays=0"), "staleDays must not be less than 1");
        assert_eq!(message("staleDays=91"), "staleDays must not be greater than 90");
        assert_eq!(message("limit=1.5"), "limit must be an integer number");
        assert_eq!(message("limit=501"), "limit must not be greater than 500");
        assert_eq!(message("days=1&limit=0"), format!("{days}; limit must not be less than 1"));
        assert_eq!(
            message("staleDays=x"),
            "staleDays must not be greater than 90; staleDays must not be less than 1; staleDays must be an integer number"
        );
    }
}
