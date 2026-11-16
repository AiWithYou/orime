use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{
        DefaultBodyLimit, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use orime::{extension_list, local_request, valid_job_id, valid_upstream};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct App {
    upstream: String,
    client: reqwest::Client,
    shutting_down: AtomicBool,
}
#[tokio::main]
async fn main() {
    let upstream = std::env::var("COMFY_URL")
        .unwrap_or("http://127.0.0.1:8188".into())
        .trim_end_matches('/')
        .to_string();
    assert!(
        valid_upstream(&upstream),
        "COMFY_URL must be a loopback http endpoint without a path"
    );
    let port: u16 = std::env::var("CANVAS_PORT")
        .unwrap_or("8199".into())
        .parse()
        .expect("invalid CANVAS_PORT");
    let app = Arc::new(App {
        upstream,
        shutting_down: AtomicBool::new(false),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .build()
            .unwrap(),
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/extensions/orime.js", get(bridge))
        .route("/canvas-api/status", get(status))
        .route(
            "/canvas-api/health",
            get(|| async {
                axum::Json(serde_json::json!({"service":"orime","pid":std::process::id()}))
            }),
        )
        .route("/canvas-api/shutdown", post(shutdown))
        .route("/canvas-api/jobs", get(jobs))
        .route("/canvas-api/drafts", get(drafts).post(save_draft))
        .route_service(
            "/canvas-api/recipes.mjs",
            tower_http::services::ServeFile::new("adapters/recipes.mjs"),
        )
        .route("/ws", get(ws))
        .nest_service(
            "/ui-assets",
            tower_http::services::ServeDir::new("web/ui-assets"),
        )
        .fallback(proxy)
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(middleware::from_fn(guard))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    println!("Orime: http://127.0.0.1:{port}");
    axum::serve(listener, router).await.unwrap();
}
async fn guard(request: Request<Body>, next: Next) -> Response {
    let h = request.headers();
    if !local_request(
        h.get("host").and_then(|v| v.to_str().ok()).unwrap_or(""),
        h.get("origin").and_then(|v| v.to_str().ok()),
    ) {
        return (StatusCode::FORBIDDEN, "Local origin required").into_response();
    }
    if h.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site")
        && !(request.method() == "GET"
            && h.get("sec-fetch-mode").and_then(|v| v.to_str().ok()) == Some("navigate"))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
async fn shutdown(
    State(s): State<Arc<App>>,
    headers: HeaderMap,
    axum::Json(_): axum::Json<serde_json::Value>,
) -> Response {
    if !orime::valid_shutdown_origin(
        headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or(""),
        headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()),
    ) {
        return (StatusCode::FORBIDDEN, "Matching local Origin required").into_response();
    }
    if s.shutting_down.swap(true, Ordering::SeqCst) {
        return (StatusCode::CONFLICT, "Shutdown already in progress").into_response();
    }
    let result = tokio::task::spawn_blocking(stop_owned_comfy).await;
    if let Err(error) = result.unwrap_or_else(|e| Err(e.to_string())) {
        s.shutting_down.store(false, Ordering::SeqCst);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("終了できませんでした: {error}"),
        )
            .into_response();
    }
    // Reply before exiting; the helper has already stopped only owned ComfyUI.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(0);
    });
    axum::Json(serde_json::json!({"status":"stopping"})).into_response()
}
#[cfg(windows)]
fn stop_owned_comfy() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let script = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .join("stop-orime.ps1");
    if !script.is_file() {
        return Err("stop-orime.ps1 がありません".into());
    }
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("-KeepProcessId")
        .arg(std::process::id().to_string())
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1000)
            .collect());
    }
    Ok(())
}
#[cfg(not(windows))]
fn stop_owned_comfy() -> Result<(), String> {
    // The managed launcher is Windows-only; other platforms stop just Orime.
    Ok(())
}
async fn index() -> Response {
    match tokio::fs::read("web/index.html").await {
        Ok(b) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], b).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Run npm install and npm run build first",
        )
            .into_response(),
    }
}
async fn bridge() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        tokio::fs::read_to_string("bridge/canvas.js")
            .await
            .unwrap_or_else(|_| include_str!("../bridge/canvas.js").into()),
    )
}
async fn jobs() -> Response {
    let mut records = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir("data/jobs").await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            if entry.path().extension().is_some_and(|e| e == "json")
                && let Ok(bytes) = tokio::fs::read(entry.path()).await
                && let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes)
            {
                if let Ok(receipt) = tokio::fs::read(entry.path().with_extension("cancel")).await {
                    value["cancelRequested"] = true.into();
                    if !matches!(value["status"].as_str(), Some("完了" | "失敗" | "停止")) {
                        value["status"] = if receipt == b"stopped" {
                            "停止"
                        } else {
                            "停止要求中"
                        }
                        .into();
                    }
                }
                records.push(value);
            }
        }
    }
    records.sort_by_key(|v| std::cmp::Reverse(v["created"].as_u64().unwrap_or(0)));
    records.truncate(100);
    axum::Json(records).into_response()
}
async fn drafts() -> Response {
    let mut records = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir("data/drafts").await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            if entry.path().extension().is_some_and(|e| e == "json")
                && let Ok(bytes) = tokio::fs::read(entry.path()).await
                && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
            {
                records.push(value);
            }
        }
    }
    records.sort_by_key(|v| std::cmp::Reverse(v["created"].as_u64().unwrap_or(0)));
    records.truncate(30);
    axum::Json(records).into_response()
}
async fn save_draft(axum::Json(mut value): axum::Json<serde_json::Value>) -> Response {
    if !orime::valid_draft(&value) {
        return (
            StatusCode::BAD_REQUEST,
            "A workflow or canvas draft is required",
        )
            .into_response();
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let id = stamp.as_nanos().to_string();
    value["id"] = serde_json::json!(id);
    value["created"] = serde_json::json!(stamp.as_millis() as u64);
    let result = async {
        tokio::fs::create_dir_all("data/drafts").await?;
        tokio::fs::write(
            format!("data/drafts/{id}.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .await
    }
    .await;
    match result {
        Ok(_) => axum::Json(value).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}
async fn persist_history(value: &serde_json::Value) {
    if let Some(entries) = value.as_object() {
        for (id, history) in entries {
            if !valid_job_id(id) {
                continue;
            }
            let path = format!("data/jobs/{id}.json");
            if let Ok(bytes) = tokio::fs::read(&path).await
                && let Ok(mut record) = serde_json::from_slice::<serde_json::Value>(&bytes)
            {
                record["status"] = serde_json::json!(orime::history_status(history));
                let images: Vec<_> = history["outputs"]
                    .as_object()
                    .into_iter()
                    .flat_map(|o| o.values())
                    .flat_map(|o| o["images"].as_array().into_iter().flatten())
                    .filter(|i| i["type"] == "output" || i["type"] == "temp")
                    .cloned()
                    .collect();
                record["images"] = serde_json::json!(images);
                record["execution_status"] = history["status"].clone();
                let _ = tokio::fs::write(&path, serde_json::to_vec(&record).unwrap()).await;
            }
        }
    }
}
async fn status(State(s): State<Arc<App>>) -> Response {
    match s
        .client
        .get(format!("{}/system_stats", s.upstream))
        .timeout(Duration::from_secs(4))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            axum::Json(serde_json::json!({"connected":true,"upstream":s.upstream})).into_response()
        }
        _ => {
            axum::Json(serde_json::json!({"connected":false,"upstream":s.upstream})).into_response()
        }
    }
}
async fn record_cancel(s: &App, id: &str) -> std::io::Result<()> {
    let path = std::path::PathBuf::from(format!("data/jobs/{id}.json"));
    if !tokio::fs::try_exists(&path).await? {
        return Ok(());
    }
    // A running interrupt is only a request. A dequeued job has no history entry.
    let queue = match s
        .client
        .get(format!("{}/queue", s.upstream))
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
        _ => None,
    };
    let gone = queue.is_some_and(|q| {
        ["queue_running", "queue_pending"].iter().all(|key| {
            q[*key]
                .as_array()
                .is_some_and(|rows| rows.iter().all(|row| row[1] != id))
        })
    });
    // Keep the acknowledgement separate so concurrent history writes retain it.
    tokio::fs::write(
        path.with_extension("cancel"),
        if gone { "stopped" } else { "requested" },
    )
    .await
}
async fn proxy(State(s): State<Arc<App>>, request: Request<Body>) -> Response {
    let (parts, body) = request.into_parts();
    let original = parts
        .uri
        .path_and_query()
        .map(|x| x.as_str())
        .unwrap_or("/");
    let mapped = orime::comfy_path(original);
    let path = mapped.as_str();
    // Fixed loopback destination; never forward browser credentials or arbitrary Host.
    let bytes = match to_bytes(body, 64 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let submitted = if parts.method == "POST" && matches!(path, "/prompt" | "/api/prompt") {
        serde_json::from_slice::<serde_json::Value>(&bytes).ok()
    } else {
        None
    };
    let cancel_id = path
        .split('?')
        .next()
        .and_then(|p| p.strip_prefix("/api/jobs/"))
        .and_then(|p| p.strip_suffix("/cancel"))
        .filter(|id| parts.method == "POST" && valid_job_id(id));
    let mut req = s
        .client
        .request(parts.method, format!("{}{path}", s.upstream))
        .timeout(Duration::from_secs(120))
        .body(bytes);
    for name in [header::CONTENT_TYPE, header::ACCEPT, header::RANGE] {
        if let Some(v) = parts.headers.get(&name) {
            req = req.header(name, v);
        }
    }
    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("ComfyUIへ接続できません: {e}"),
            )
                .into_response();
        }
    };
    let status = response.status();
    if let Some(id) = cancel_id {
        return match response.json::<serde_json::Value>().await {
            Ok(value) => {
                if status.is_success()
                    && value["cancelled"] == true
                    && let Err(e) = record_cancel(&s, id).await
                {
                    eprintln!("Cannot persist cancellation of job {id}: {e}");
                }
                (status, axum::Json(value)).into_response()
            }
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        };
    }
    if path.starts_with("/history/") || path.starts_with("/api/history/") {
        return match response.json::<serde_json::Value>().await {
            Ok(value) => {
                persist_history(&value).await;
                (status, axum::Json(value)).into_response()
            }
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        };
    }
    if let Some(submitted) = submitted {
        return match response.json::<serde_json::Value>().await {
            Ok(value) => {
                if status.is_success()
                    && let Some(id) = value["prompt_id"].as_str().filter(|id| valid_job_id(id))
                {
                    let created = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let metadata = &submitted["extra_data"]["aikimi"];
                    let record = serde_json::json!({"id":id,"created":created,"status":"未確認","family":metadata["family"].as_str().unwrap_or("ComfyUI"),"prompt":metadata["prompt"].as_str().unwrap_or(""),"workflow":submitted["extra_data"]["extra_pnginfo"]["workflow"],"api":submitted["prompt"],"images":[]});
                    if let Err(e) = async {
                        tokio::fs::create_dir_all("data/jobs").await?;
                        tokio::fs::write(
                            format!("data/jobs/{id}.json"),
                            serde_json::to_vec(&record).unwrap(),
                        )
                        .await
                    }
                    .await
                    {
                        eprintln!("Cannot persist job {id}: {e}");
                    }
                }
                (status, axum::Json(value)).into_response()
            }
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        };
    }
    if path == "/extensions" || path == "/api/extensions" {
        return match response.json::<serde_json::Value>().await {
            Ok(v) => (status, axum::Json(extension_list(v))).into_response(),
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        };
    }
    let mut builder = Response::builder().status(status);
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = response.headers().get(&name) {
            builder = builder.header(name, v);
        }
    }
    builder
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap()
}
async fn ws(
    State(s): State<Arc<App>>,
    upgrade: WebSocketUpgrade,
    request: axum::extract::OriginalUri,
) -> Response {
    let url = format!("{}{}", s.upstream.replacen("http:", "ws:", 1), request.0);
    match tokio_tungstenite::connect_async(url).await {
        Ok((upstream, _)) => upgrade.on_upgrade(move |socket| tunnel(socket, upstream)),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}
async fn tunnel(
    client: WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    use tokio_tungstenite::tungstenite::Message as T;
    let (mut cw, mut cr) = client.split();
    let (mut uw, mut ur) = upstream.split();
    let a = async {
        while let Some(Ok(m)) = cr.next().await {
            let m = match m {
                Message::Text(v) => T::Text(v.to_string().into()),
                Message::Binary(v) => T::Binary(v),
                Message::Ping(v) => T::Ping(v),
                Message::Pong(v) => T::Pong(v),
                Message::Close(_) => break,
            };
            if uw.send(m).await.is_err() {
                break;
            }
        }
    };
    let b = async {
        while let Some(Ok(m)) = ur.next().await {
            let m = match m {
                T::Text(v) => Message::Text(v.to_string().into()),
                T::Binary(v) => Message::Binary(v),
                T::Ping(v) => Message::Ping(v),
                T::Pong(v) => Message::Pong(v),
                T::Close(_) => break,
                _ => continue,
            };
            if cw.send(m).await.is_err() {
                break;
            }
        }
    };
    tokio::select! {_ = a=>{},_ = b=>{}}
}
