use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::Cookie;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

use crate::auth::token::{generate_token, verify_token};
use crate::error::{AppError, FieldError};
use crate::models::{Account, AccountSettings, User, UserFlags};
use crate::state::SharedState;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    email: String,
    password: String,
    confirm_password: String,
    username: String,
    invite_code: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    user: User,
    account: Account,
    settings: AccountSettings,
}

fn generate_tag() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let chars: Vec<char> = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        .chars()
        .collect();
    (0..5)
        .map(|_| chars[rng.gen_range(0..chars.len())])
        .collect()
}

fn generate_snowflake() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let epoch = 1420070400000u64;
    let timestamp = now - epoch;

    use rand::Rng;
    let random: u64 = rand::thread_rng().gen_range(0..4096);

    let id = (timestamp << 22) | random;
    id.to_string()
}

fn validate_password(password: &str) -> Vec<FieldError> {
    let mut errors = Vec::new();

    if password.len() < 8 {
        errors.push(FieldError {
            code: "register.errors.passwordTooShort".to_string(),
            path: "password".to_string(),
        });
    }
    if password.len() > 128 {
        errors.push(FieldError {
            code: "register.errors.passwordTooLong".to_string(),
            path: "password".to_string(),
        });
    }
    if !password.chars().any(|c| c.is_lowercase()) {
        errors.push(FieldError {
            code: "register.errors.passwordLowercase".to_string(),
            path: "password".to_string(),
        });
    }
    if !password.chars().any(|c| c.is_uppercase()) {
        errors.push(FieldError {
            code: "register.errors.passwordUppercase".to_string(),
            path: "password".to_string(),
        });
    }
    if !password.chars().any(|c| c.is_numeric()) {
        errors.push(FieldError {
            code: "register.errors.passwordDigit".to_string(),
            path: "password".to_string(),
        });
    }
    if !password
        .chars()
        .any(|c| "$&+,:;=?@#|'<>.^*()%!-".contains(c))
    {
        errors.push(FieldError {
            code: "register.errors.passwordSpecialCharacter".to_string(),
            path: "password".to_string(),
        });
    }

    errors
}

fn token_cookie(token: String) -> Cookie<'static> {
    let is_production = std::env::var("NODE_ENV").unwrap_or_default() == "production";
    let cookie_name = if is_production {
        "__Host-Token"
    } else {
        "token"
    };

    let mut cookie = Cookie::new(cookie_name, token);
    cookie.set_path("/");
    // Without an expiry it is a session cookie, which the desktop app forgets whenever it restarts.
    cookie.set_max_age(time::Duration::days(365));
    if is_production {
        cookie.set_http_only(true);
        cookie.set_secure(true);
    }
    cookie
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/login", post(login))
        .route("/register", post(register))
        .route("/session", get(session))
        .route("/logout", post(logout))
        .route("/clear-db", delete(clear_db))
}

#[utoipa::path(
    post,
    path = "/auth/login",
    tag = "Auth",
    summary = "Sign in with email and password",
    request_body = LoginRequest,
    responses(
    (status = 204, description = "Signed in. The session token is set as a cookie."),
    (status = 400, description = "Validation failed", body = crate::openapi::ValidationErrorBody)
),
)]
pub(crate) async fn login(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<LoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    if body.email.is_empty() || !body.email.contains('@') {
        return Err(AppError::ValidationFailed(vec![FieldError {
            code: "login.errors.invalidEmail".to_string(),
            path: "email".to_string(),
        }]));
    }

    let account = state
        .db
        .accounts
        .find_first(|q| q.where_email(body.email.clone()))
        .await?;

    let account = match account {
        Some(a) => a,
        None => {
            return Err(AppError::ValidationFailed(vec![
                FieldError {
                    code: "login.errors.incorrectDetails".to_string(),
                    path: "email".to_string(),
                },
                FieldError {
                    code: "login.errors.incorrectDetails".to_string(),
                    path: "password".to_string(),
                },
            ]));
        }
    };

    let parsed_hash = PasswordHash::new(&account.password)
        .map_err(|_| AppError::InternalServerError("Invalid password hash".to_string()))?;

    if Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed_hash)
        .is_err()
    {
        return Err(AppError::ValidationFailed(vec![
            FieldError {
                code: "login.errors.incorrectDetails".to_string(),
                path: "email".to_string(),
            },
            FieldError {
                code: "login.errors.incorrectDetails".to_string(),
                path: "password".to_string(),
            },
        ]));
    }

    Ok((jar.add(token_cookie(account.token)), StatusCode::NO_CONTENT))
}

#[utoipa::path(
    post,
    path = "/auth/register",
    tag = "Auth",
    summary = "Create an account",
    description = "Registration may require an invite code (REGISTRATION_CLOSED).",
    request_body = RegisterRequest,
    responses(
    (status = 204, description = "Account created and signed in."),
    (status = 400, description = "Validation failed", body = crate::openapi::ValidationErrorBody)
),
)]
pub(crate) async fn register(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<RegisterRequest>,
) -> Result<impl IntoResponse, AppError> {
    let mut errors = Vec::new();

    if body.email.is_empty() || !body.email.contains('@') {
        errors.push(FieldError {
            code: "login.errors.invalidEmail".to_string(),
            path: "email".to_string(),
        });
    }

    if body.username.len() < 2 {
        errors.push(FieldError {
            code: "register.errors.usernameTooShort".to_string(),
            path: "username".to_string(),
        });
    }
    if body.username.len() > 64 {
        errors.push(FieldError {
            code: "register.errors.usernameTooLong".to_string(),
            path: "username".to_string(),
        });
    }

    errors.extend(validate_password(&body.password));

    if body.password != body.confirm_password {
        errors.push(FieldError {
            code: "register.errors.passwordNotConfirmed".to_string(),
            path: "confirmPassword".to_string(),
        });
    }

    if !errors.is_empty() {
        return Err(AppError::ValidationFailed(errors));
    }

    if state.config.registration_closed {
        println!(
            "Registration closed. Value: {}",
            state.config.registration_closed
        );
        match &body.invite_code {
            None => {
                return Err(AppError::ValidationFailed(vec![FieldError {
                    code: "register.errors.inviteCodeRequired".to_string(),
                    path: "inviteCode".to_string(),
                }]));
            }
            Some(code) => {
                let invite = state
                    .db
                    .invite_codes
                    .find_first(|q| q.where_code(code.clone()))
                    .await?;

                if invite.is_none() {
                    return Err(AppError::ValidationFailed(vec![FieldError {
                        code: "register.errors.invalidInviteCode".to_string(),
                        path: "inviteCode".to_string(),
                    }]));
                }

                state
                    .db
                    .invite_codes
                    .delete(|d| d.where_code(code.clone()))
                    .await?;
            }
        }
    }

    let existing = state
        .db
        .accounts
        .find_first(|q| q.where_email(body.email.clone()))
        .await?;

    if existing.is_some() {
        return Err(AppError::ValidationFailed(vec![FieldError {
            code: "register.errors.emailAlreadyClaimed".to_string(),
            path: "email".to_string(),
        }]));
    }

    let user_count = state.db.users.count(|q| q).await?;

    let tag = generate_tag();
    let existing_user = state
        .db
        .users
        .find_first(|q| {
            q.where_username(body.username.clone())
                .where_tag(tag.clone())
        })
        .await?;

    if existing_user.is_some() {
        return Err(AppError::ValidationFailed(vec![FieldError {
            code: "register.errors.usernameTagTooPopular".to_string(),
            path: "username".to_string(),
        }]));
    }

    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let password_hash = argon2
        .hash_password(body.password.as_bytes(), &salt)
        .map_err(|_| AppError::InternalServerError("Failed to hash password".to_string()))?
        .to_string();

    let user_id = generate_snowflake();
    let flags = if user_count == 0 { UserFlags::ADMIN } else { 0 };
    let token = generate_token(&user_id, 0, &state.config.token_secret);

    state
        .db
        .users
        .create(|c| {
            c.set_id(user_id.clone())
                .set_username(body.username.clone())
                .set_tag(tag)
                .set_flags(flags)
                .set_bot(false)
        })
        .await?;

    state
        .db
        .account_settings
        .create(|c| c.set_account_id(user_id.clone()))
        .await?;

    state
        .db
        .accounts
        .create(|c| {
            c.set_id(user_id.clone())
                .set_email(body.email)
                .set_password(password_hash)
                .set_user_id(user_id.clone())
                .set_token(token.clone())
                .set_email_verified(false)
                .set_locale("en_us".to_string())
                .set_settings_id(user_id.clone())
        })
        .await?;

    Ok((jar.add(token_cookie(token)), StatusCode::NO_CONTENT))
}

#[utoipa::path(
    get,
    path = "/auth/session",
    tag = "Auth",
    summary = "Current session",
    responses(
    (status = 200, description = "The signed-in user", body = SessionResponse),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn session(
    State(state): State<SharedState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, AppError> {
    let is_production = std::env::var("NODE_ENV").unwrap_or_default() == "production";
    let cookie_name = if is_production {
        "__Host-Token"
    } else {
        "token"
    };

    let token = jar
        .get(cookie_name)
        .map(|c| c.value().to_string())
        .ok_or(AppError::Unauthorized)?;

    let _token_data =
        verify_token(&token, &state.config.token_secret).ok_or(AppError::Unauthorized)?;

    let account = state
        .db
        .accounts
        .find_first(|q| q.where_token(token))
        .await?
        .ok_or(AppError::Unauthorized)?;

    let user = state
        .db
        .users
        .find_first(|q| q.where_id(account.user_id.clone()))
        .await?
        .ok_or(AppError::Unauthorized)?;

    Ok(Json(SessionResponse {
        user: user.into(),
        account: Account {
            id: account.id,
            email: account.email,
            email_verified: account.email_verified,
            locale: account.locale,
        },
        settings: AccountSettings {
            theme: "LIGHT".to_string(),
            compact_mode: Some(false),
            compact_show_avatars: Some(true),
            pending_deletion: None,
            delete_at: None,
        },
    }))
}

#[utoipa::path(
    post,
    path = "/auth/logout",
    tag = "Auth",
    summary = "Sign out",
    responses(
    (status = 204, description = "Cookie cleared")
),
)]
pub(crate) async fn logout(jar: CookieJar) -> impl IntoResponse {
    let is_production = std::env::var("NODE_ENV").unwrap_or_default() == "production";
    let cookie_name = if is_production {
        "__Host-Token"
    } else {
        "token"
    };

    let mut cookie = Cookie::new(cookie_name, "");
    cookie.set_path("/");
    cookie.set_max_age(time::Duration::ZERO);

    (jar.add(cookie), StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/auth/clear-db",
    tag = "Auth",
    summary = "Wipe users and accounts",
    description = "Development only. Fails with 500 in production.",
    responses(
    (status = 204, description = "Wiped"),
    (status = 500, description = "Production", body = crate::openapi::ErrorBody)
),
)]
pub(crate) async fn clear_db(
    State(state): State<SharedState>,
) -> Result<impl IntoResponse, AppError> {
    let is_production = std::env::var("NODE_ENV").unwrap_or_default() == "production";

    if is_production {
        return Err(AppError::InternalServerError(
            "This endpoint can only be used from a development environment.".to_string(),
        ));
    }

    state.db.users.delete(|d| d).await?;
    state.db.accounts.delete(|d| d).await?;

    Ok(StatusCode::NO_CONTENT)
}
