//! Exécution en service Windows (`corvus-agent run --service`). Le gestionnaire de services (SCM) exige qu'un service lui
//! réponde dans les 30 s : on s'enregistre, on annonce « en cours », puis on lance la boucle ordinaire de l'agent, qui rend la
//! main quand le SCM demande l'arrêt (le drapeau d'arrêt est lu à chaque tour).
//!
//! L'installation (création du service, compte virtuel dédié, ACL) est faite par `install.ps1`, pas par l'agent : l'agent ne
//! s'auto-installe pas.

use std::ffi::OsString;
use std::sync::OnceLock;
use std::time::Duration;
use windows_service::service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

pub const SERVICE_NAME: &str = "CorvusAgent";

/// Arguments de `run` (dossier de données, dossiers surveillés…), transmis à la boucle de l'agent.
static ARGS: OnceLock<Vec<String>> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

/// Bloque jusqu'à l'arrêt du service. Échoue tout de suite si l'agent n'a pas été lancé par le gestionnaire de services.
pub fn dispatch(args: Vec<String>) -> Result<(), String> {
    let _ = ARGS.set(args);
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .map_err(|e| format!("démarrage en service impossible (lancé hors du gestionnaire de services ?) : {e}"))
}

fn status(state: ServiceState, accepted: ServiceControlAccept, exit_code: ServiceExitCode) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accepted,
        exit_code,
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    }
}

fn service_main(_arguments: Vec<OsString>) {
    let args = ARGS.get().cloned().unwrap_or_default();
    let handler = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            crate::request_stop();
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    });
    let Ok(handle) = handler else { return };

    let _ = handle.set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN, ServiceExitCode::NO_ERROR));
    let result = crate::run(&args);
    if let Err(e) = &result {
        eprintln!("erreur : {e}");
    }
    let code = if result.is_ok() { ServiceExitCode::NO_ERROR } else { ServiceExitCode::ServiceSpecific(1) };
    let _ = handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty(), code));
}
