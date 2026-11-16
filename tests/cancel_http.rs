use axum::{
    Json, Router,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Fixture {
    child: Child,
    dir: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn acknowledged_cancel_survives_reload_and_execution_history_wins() {
    let backend = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let upstream = backend.local_addr().unwrap();
    let mock = Router::new()
        .route(
            "/queue",
            get(|| async { Json(json!({"queue_running": [], "queue_pending": []})) }),
        )
        .route(
            "/api/jobs/{id}/cancel",
            post(
                |axum::extract::Path(id): axum::extract::Path<String>| async move {
                    Json(json!({"cancelled": id != "unknown"}))
                },
            ),
        )
        .route(
            "/history/done",
            get(|| async { Json(json!({"done":{"status":{"completed":true}, "outputs":{}}})) }),
        );
    let task = tokio::spawn(async move { axum::serve(backend, mock).await.unwrap() });
    let port_reservation = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = port_reservation.local_addr().unwrap().port();
    let dir = std::env::temp_dir().join(format!("orime-{}-{port}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    let jobs = dir.join("data/jobs");
    std::fs::create_dir_all(&jobs).unwrap();
    for id in ["queued", "unknown", "done"] {
        std::fs::write(
            jobs.join(format!("{id}.json")),
            json!({"id":id,"status":"未確認","workflow":{"nodes":[]}}).to_string(),
        )
        .unwrap();
    }
    drop(port_reservation);
    let child = Command::new(env!("CARGO_BIN_EXE_orime"))
        .current_dir(&dir)
        .env("CANVAS_PORT", port.to_string())
        .env("COMFY_URL", format!("http://{upstream}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _fixture = Fixture { child, dir };
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}");
    for _ in 0..100 {
        if client
            .get(format!("{url}/canvas-api/jobs"))
            .send()
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    for id in ["queued", "unknown", "done"] {
        let result: Value = client
            .post(format!("{url}/api/jobs/{id}/cancel"))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["cancelled"], id != "unknown");
    }
    client
        .get(format!("{url}/history/done"))
        .send()
        .await
        .unwrap();
    let records: Vec<Value> = client
        .get(format!("{url}/canvas-api/jobs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let status = |id| &records.iter().find(|r| r["id"] == id).unwrap()["status"];
    assert_eq!(status("queued"), "停止");
    assert_eq!(status("unknown"), "未確認");
    assert_eq!(status("done"), "完了");
    task.abort();
}
