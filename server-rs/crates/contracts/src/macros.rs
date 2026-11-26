//! `string_enum!`: a TS string-literal union as a Rust enum.

/// Declares a `Copy` enum whose serde (and `OpenAPI`) names are the given wire strings, with
/// `ALL`, `as_str`, `parse` and `Display`.
///
/// ```text
/// string_enum! {
///     /// Doc of the type.
///     pub enum Priority {
///         None = "none",
///         Urgent = "urgent",
///     }
/// }
/// ```
macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $( $(#[$vmeta:meta])* $variant:ident = $wire:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord,
            serde::Serialize, serde::Deserialize, utoipa::ToSchema,
        )]
        $vis enum $name {
            $(
                $(#[$vmeta])*
                #[doc = concat!("Wire value `", $wire, "`.")]
                #[serde(rename = $wire)]
                $variant,
            )+
        }

        impl $name {
            /// Every value, in the order the contract lists them.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            /// The wire string.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }

            /// The value named by a wire string, `None` for anything else.
            #[must_use]
            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($wire => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.as_str().to_owned()
            }
        }
    };
}
