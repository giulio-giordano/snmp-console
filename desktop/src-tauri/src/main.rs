#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/** Own the bundled Bun server process for the lifetime of the desktop app. */
struct BackendProcess(Mutex<Option<CommandChild>>);

/** Stop the sidecar when Tauri exits, avoiding an orphaned local SNMP server. */
impl Drop for BackendProcess {
    fn drop(&mut self) {
        if let Ok(child_slot) = self.0.get_mut() {
            if let Some(child) = child_slot.take() {
                let _ = child.kill();
            }
        }
    }
}

/** Start the Tauri desktop shell and its local SNMP backend. */
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = if cfg!(debug_assertions) {
                // Tauri development mode uses the Bun dev server started by beforeDevCommand.
                3000
            } else {
                let port = select_local_port()?;
                start_bundled_backend(app, port)?;
                port
            };

            wait_for_backend(port)?;
            let url = format!("http://127.0.0.1:{port}/");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("SNMP Console")
                .inner_size(1280.0, 900.0)
                .min_inner_size(820.0, 620.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the SNMP Console desktop application");
}

/** Launch and retain the compiled Bun HTTP/SNMP sidecar for production builds. */
fn start_bundled_backend(
    app: &mut tauri::App,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let (mut events, child) = app
        .shell()
        .sidecar("snmp-backend")?
        .env("PORT", port.to_string())
        .spawn()?;
    app.manage(BackendProcess(Mutex::new(Some(child))));

    // Drain the process event channel so stdout/stderr cannot block the backend.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if matches!(event, CommandEvent::Terminated(_)) {
                break;
            }
        }
    });
    Ok(())
}

/** Reserve an ephemeral loopback port for the packaged backend process. */
fn select_local_port() -> Result<u16, std::io::Error> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/** Wait for the Bun sidecar or development server to answer its local health route. */
fn wait_for_backend(port: u16) -> Result<(), std::io::Error> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(15);
    let health_request =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");

    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = stream.write_all(health_request.as_bytes());
            let mut response = Vec::new();
            if stream.read_to_end(&mut response).is_ok()
                && response.starts_with(b"HTTP/1.1 200")
                && response
                    .windows(13)
                    .any(|part| part == b"\"status\":\"ok\"")
            {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(100));
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!("SNMP backend did not become ready on 127.0.0.1:{port}"),
    ))
}
