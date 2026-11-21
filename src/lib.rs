use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use url::Url;

static DRAFT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn next_draft_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = DRAFT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{nanos}-{seq}")
}
pub fn valid_shutdown_origin(host: &str, origin: Option<&str>) -> bool {
    origin.is_some() && local_request(host, origin)
}
pub fn comfy_path(original: &str) -> String {
    if original == "/nodes" {
        "/".into()
    } else if let Some(query) = original.strip_prefix("/nodes?") {
        format!("/?{query}")
    } else if original.starts_with("/nodes/") {
        original[6..].into()
    } else {
        original.into()
    }
}
pub fn valid_draft(value: &Value) -> bool {
    value["workflow"]["nodes"].is_array()
        || (value["aikimiDraft"] == true
            && value["family"].is_string()
            && value["settings"].is_object())
}
pub fn history_status(history: &Value) -> &'static str {
    let status = &history["status"];
    if status["messages"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|m| m[0] == "execution_interrupted"))
    {
        "停止"
    } else if status["status_str"] == "error" {
        "失敗"
    } else if status["completed"] == true {
        "完了"
    } else {
        "生成中"
    }
}
pub fn valid_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn valid_upstream(value: &str) -> bool {
    Url::parse(value).is_ok_and(|u| {
        u.scheme() == "http"
            && is_local(u.host_str().unwrap_or(""))
            && u.username().is_empty()
            && u.password().is_none()
            && u.path() == "/"
            && u.query().is_none()
            && u.fragment().is_none()
    })
}
fn is_local(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}
pub fn local_request(host: &str, origin: Option<&str>) -> bool {
    let Ok(u) = Url::parse(&format!("http://{host}")) else {
        return false;
    };
    is_local(u.host_str().unwrap_or(""))
        && u.username().is_empty()
        && u.password().is_none()
        && u.path() == "/"
        && u.query().is_none()
        && u.fragment().is_none()
        && origin.is_none_or(|o| o == format!("http://{host}"))
}
pub fn extension_list(mut value: Value) -> Value {
    if let Some(list) = value.as_array_mut() {
        let bridge = Value::String("/extensions/orime.js".into());
        if !list.contains(&bridge) {
            list.push(bridge);
        }
    }
    value
}
