// Compile the exact private metadata codec independently of the CLI executable.
// This target grants no native owner and exercises no model or service action.
#[path = "../src/app_server"]
mod app_server {
    mod integrations {
        mod core {
            mod service_leases {
                mod native_code {
                    mod diagnostics;
                }
            }
        }
    }
}
