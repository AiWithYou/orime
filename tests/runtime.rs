use orime::{extension_list, local_request, valid_upstream};
#[test]
fn shutdown_requires_an_explicit_matching_local_origin() {
    use orime::valid_shutdown_origin;
    assert!(valid_shutdown_origin(
        "127.0.0.1:8199",
        Some("http://127.0.0.1:8199")
    ));
    assert!(!valid_shutdown_origin("127.0.0.1:8199", None));
    assert!(!valid_shutdown_origin("127.0.0.1:8199", Some("null")));
    assert!(!valid_shutdown_origin(
        "127.0.0.1:8199",
        Some("http://127.0.0.1:8188")
    ));
    assert!(!valid_shutdown_origin(
        "example.com",
        Some("http://example.com")
    ));
}
#[test]
fn node_resources_resolve_at_comfy_root() {
    use orime::comfy_path;
    assert_eq!(comfy_path("/nodes"), "/");
    assert_eq!(comfy_path("/nodes/"), "/");
    assert_eq!(comfy_path("/nodes?mode=graph"), "/?mode=graph");
    assert_eq!(
        comfy_path("/nodes/assets/sorted-custom-node-map.json?v=1"),
        "/assets/sorted-custom-node-map.json?v=1"
    );
    assert_eq!(comfy_path("/nodes-extra/file"), "/nodes-extra/file");
    assert_eq!(
        comfy_path("/api/userdata/user.css"),
        "/api/userdata/user.css"
    );
}
#[test]
fn drafts_can_preserve_work_before_a_graph_exists() {
    assert!(orime::valid_draft(
        &serde_json::json!({"aikimiDraft":true,"family":"sdxl","settings":{"prompt":"unsent"},"canvasImage":"source.png"})
    ));
    assert!(orime::valid_draft(
        &serde_json::json!({"workflow":{"nodes":[]}})
    ));
    assert!(!orime::valid_draft(
        &serde_json::json!({"aikimiDraft":true})
    ));
}
#[test]
fn interrupted_jobs_are_not_completed_or_generic_failures() {
    assert_eq!(
        orime::history_status(
            &serde_json::json!({"status":{"completed":true,"status_str":"success"}})
        ),
        "完了"
    );
    assert_eq!(
        orime::history_status(
            &serde_json::json!({"status":{"completed":false,"status_str":"error","messages":[["execution_interrupted",{}]]}})
        ),
        "停止"
    );
    assert_eq!(orime::history_status(&serde_json::json!({})), "生成中");
}
#[test]
fn job_ids_cannot_escape_storage() {
    assert!(orime::valid_job_id("abc-123"));
    for id in ["../secret", "a/b", "", "a\\b", "a?x"] {
        assert!(!orime::valid_job_id(id));
    }
}
#[test]
fn only_loopback_upstream() {
    assert!(valid_upstream("http://127.0.0.1:8188"));
    assert!(valid_upstream("http://localhost:8188/"));
    for url in [
        "https://example.com",
        "http://127.0.0.1.evil.com",
        "file:///tmp",
        "http://user:pass@localhost",
        "http://localhost/path",
    ] {
        assert!(!valid_upstream(url), "{url}");
    }
}
#[test]
fn host_and_origin_must_match() {
    assert!(local_request(
        "127.0.0.1:8199",
        Some("http://127.0.0.1:8199")
    ));
    assert!(local_request("localhost:8199", None));
    assert!(!local_request("evil.com:8199", None));
    assert!(!local_request("localhost:8199", Some("https://evil.com")));
    assert!(!local_request("localhost:8199", Some("null")));
}
#[test]
fn bridge_is_added_once_preserving_extensions() {
    let list = serde_json::json!(["/extensions/foo.js"]);
    let out = extension_list(list);
    assert_eq!(out.as_array().unwrap().len(), 2);
    assert_eq!(extension_list(out.clone()), out);
}

#[test]
fn rejects_malformed_local_hosts() {
    for host in [
        "localhost:8199/path",
        "localhost:8199?q",
        "localhost:8199#fragment",
        ":password@localhost:8199",
    ] {
        assert!(!local_request(host, None), "{host}");
    }
}

#[test]
fn draft_ids_are_unique_across_rapid_calls() {
    let a = orime::next_draft_id();
    let b = orime::next_draft_id();
    assert_ne!(a, b);
    assert!(a.bytes().all(|c| c.is_ascii_digit() || c == b'-'));
}
