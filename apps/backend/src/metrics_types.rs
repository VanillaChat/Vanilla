//! Gateway metrics wire types, shared by the server and `vanilla-tui`.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GatewayMetricEntry {
    pub key: String,
    pub count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GatewayRecentEvent {
    pub at_ms: u128,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayMetricsSnapshot {
    pub connected_sockets: u64,
    pub identified_users: usize,
    pub subscribed_rooms: usize,
    pub total_inbound: u64,
    pub total_dispatches: u64,
    pub total_broadcasts: u64,
    pub inbound_by_op: Vec<GatewayMetricEntry>,
    pub dispatch_by_type: Vec<GatewayMetricEntry>,
    pub broadcasts_by_room: Vec<GatewayMetricEntry>,
    pub recent: Vec<GatewayRecentEvent>,
}
