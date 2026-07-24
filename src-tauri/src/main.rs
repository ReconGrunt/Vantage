// Vantage - native Windows desktop shell (Tauri v2 + WebView2).
//
// The app embeds an axum HTTP server on 127.0.0.1:47615 (fixed port so WebView localStorage,
// which is keyed by origin+port, persists across launches) that serves BOTH the embedded
// frontend and the /api/* proxy contract. The window is created at runtime pointing at that
// localhost origin, so public/ stays a plain browser app - every native feature is driven
// from Rust here, no Tauri IPC in the frontend.
// Always use the Windows GUI subsystem — no console window on launch, in debug or release.
// (The stock Tauri template keeps a console in debug for logs; this is a windowed kiosk app,
// so the terminal is never wanted. Logs can be surfaced via the /api layer if needed.)
#![windows_subsystem = "windows"]

mod proxy;
mod server;
mod static_assets;

use std::net::TcpListener as StdTcpListener;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_window_state::{StateFlags, WindowExt};
use tokio::sync::oneshot;

const PORT: u16 = 47615;

/// Holds the graceful-shutdown trigger for the embedded axum server.
struct ShutdownHandle(Mutex<Option<oneshot::Sender<()>>>);

fn main() {
    tauri::Builder::default()
        // single-instance MUST be registered first: a second launch forwards to the
        // running instance (show + focus) instead of fighting for the fixed port.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // 1) Bind the listener synchronously so "listening" is guaranteed before the
            //    window loads. Fall back to an ephemeral port if 47615 is taken.
            let (std_listener, port) = bind_listener();
            std_listener.set_nonblocking(true)?;

            // 2) Spawn axum with graceful shutdown.
            let state = server::AppState::new();
            let router = server::build_router(state);
            let (tx, rx) = oneshot::channel::<()>();
            app.manage(ShutdownHandle(Mutex::new(Some(tx))));
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(std_listener)
                    .expect("adopt std listener into tokio");
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = rx.await;
                    })
                    .await;
            });

            // 3) Create the window pointing at the local server.
            let url = format!("http://127.0.0.1:{}/", port);
            let win = WebviewWindowBuilder::new(
                &handle,
                "main",
                WebviewUrl::External(url.parse().expect("valid localhost url")),
            )
            .title("Vantage \u{00B7} Air")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 640.0)
            .visible(false)
            .build()?;

            // Restore size/position (but not visibility - we always start shown), then show.
            let _ = win.restore_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
            let _ = win.show();

            // 4) Minimize-to-tray: closing hides the window and pauses the render loop.
            let render = win.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = render.hide();
                    let _ = render.eval("window.__vantageActive && window.__vantageActive(false)");
                }
            });

            // 5) System tray with Show / Check-for-updates / Quit.
            build_tray(&handle)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Vantage")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<ShutdownHandle>() {
                    if let Some(tx) = state.0.lock().unwrap().take() {
                        let _ = tx.send(()); // let axum drain
                    }
                }
            }
        });
}

/// Bind 127.0.0.1:47615, or an ephemeral loopback port if it's taken. Never 0.0.0.0.
fn bind_listener() -> (StdTcpListener, u16) {
    match StdTcpListener::bind(("127.0.0.1", PORT)) {
        Ok(l) => {
            let p = l.local_addr().map(|a| a.port()).unwrap_or(PORT);
            (l, p)
        }
        Err(e) => {
            eprintln!(
                "Vantage: 127.0.0.1:{} unavailable ({}); using an ephemeral port - \
                 persisted UI state may reset for this session.",
                PORT, e
            );
            let l = StdTcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral loopback port");
            let p = l.local_addr().expect("ephemeral local_addr").port();
            (l, p)
        }
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Vantage", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "check_update", "Check for Updates\u{2026}", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Vantage", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &update, &quit])?;

    TrayIconBuilder::with_id("vantage-tray")
        .icon(app.default_window_icon().expect("bundled window icon").clone())
        .tooltip("Vantage \u{00B7} Air")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal(app),
            "check_update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(check_update(app));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Show + focus the main window and resume its render loop.
fn reveal(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.eval("window.__vantageActive && window.__vantageActive(true)");
    }
}

/// Best-effort auto-update: check the configured endpoint, install if newer, relaunch.
async fn check_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    if let Ok(updater) = app.updater() {
        if let Ok(Some(update)) = updater.check().await {
            if update.download_and_install(|_chunk, _total| {}, || {}).await.is_ok() {
                app.restart();
            }
        }
    }
}
