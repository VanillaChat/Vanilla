pub mod admin;
pub mod attachments;
pub mod audit;
pub mod auth;
pub mod cdn;
pub mod channels;
pub mod dms;
pub mod friends;
pub mod guilds;
pub mod invites;
pub mod roles;
pub mod search;
pub mod share;
pub mod unfurl;
pub mod users;
pub mod voice;

use crate::state::SharedState;
use axum::Router;

pub fn create_router() -> Router<SharedState> {
    Router::new()
        .nest("/auth", auth::router())
        .nest("/guilds", guilds::router())
        .nest("/channels", channels::router())
        .nest("/users", users::router())
        .nest("/invites", invites::router())
        .nest("/admin", admin::router())
        .nest("/cdn", cdn::router())
        .nest("/dms", dms::router())
        .nest("/friends", friends::router())
        .nest("/search", search::router())
        .nest("/unfurl", unfurl::router())
        .merge(share::router())
        .merge(voice::router())
        .merge(attachments::router())
}

#[cfg(test)]
mod tests {
    #[test]
    fn router_builds_without_route_conflicts() {
        let _ = super::create_router();
    }
}
