//! Payroll `Layer::Ui` surface. SSR HTML for `/_ui`; no payroll math.
//!
//! Unauthenticated markup is empty deny-by-omission. Authorized run summaries
//! are composed server-side from OpenAPI `PayrollRunSummary` required fields
//! (no won amounts). `AuthorizedRuns` is a Leptos island. WASM hydration loads
//! `/_ui/pkg/*` only on the authorized shell.
use leptos::prelude::*;
use serde::{Deserialize, Serialize};

/// Contract-shaped run summary for SSR composition. Field names match
/// `PayrollRunSummary.yaml` required keys; values are already-authorized.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSummary {
    pub id: String,
    pub period_start: String,
    pub period_end: String,
    pub source_label: String,
    pub status: String,
    pub calculation_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[component]
pub fn Shell() -> impl IntoView {
    view! {
        <html>
            <head>
                <meta charset="utf-8" />
            </head>
            <body></body>
        </html>
    }
}

#[island]
pub fn AuthorizedRuns(runs: Vec<RunSummary>) -> impl IntoView {
    runs.into_iter()
        .map(|run| {
            view! {
                <span
                    data-run-id=run.id
                    data-period-start=run.period_start
                    data-period-end=run.period_end
                    data-source-label=run.source_label
                    data-status=run.status
                    data-calculation-enabled=run.calculation_enabled.to_string()
                    data-created-at=run.created_at
                    data-updated-at=run.updated_at
                ></span>
            }
        })
        .collect_view()
}

#[component]
pub fn AuthorizedShell(runs: Vec<RunSummary>) -> impl IntoView {
    view! {
        <html>
            <head>
                <meta charset="utf-8" />
                <script type="module" src="/_ui/pkg/hydrate.js"></script>
            </head>
            <body>
                <AuthorizedRuns runs=runs />
            </body>
        </html>
    }
}

pub fn shell() -> impl IntoView {
    Shell()
}

pub fn render_shell() -> String {
    let mut html = String::from("<!DOCTYPE html>");
    html.push_str(&shell().to_html());
    html
}

pub fn render_shell_with(runs: &[RunSummary]) -> String {
    if runs.is_empty() {
        return render_shell();
    }
    let runs = runs.to_vec();
    let mut html = String::from("<!DOCTYPE html>");
    html.push_str(&view! { <AuthorizedShell runs=runs /> }.to_html());
    html
}

#[cfg(feature = "ssr")]
mod ssr {
    use super::{RunSummary, render_shell, render_shell_with};
    use axum::response::Html;

    pub fn html_shell() -> Html<String> {
        Html(render_shell())
    }

    pub fn html_shell_with(runs: &[RunSummary]) -> Html<String> {
        Html(render_shell_with(runs))
    }

    pub fn hydrate_js() -> &'static str {
        include_str!("../hydrate.js")
    }

    pub fn payroll_ui_js() -> &'static [u8] {
        include_bytes!("../pkg/console_payroll_ui.js")
    }

    pub fn payroll_ui_wasm() -> &'static [u8] {
        include_bytes!("../pkg/console_payroll_ui_bg.wasm")
    }
}

#[cfg(feature = "ssr")]
pub use ssr::{html_shell, html_shell_with, hydrate_js, payroll_ui_js, payroll_ui_wasm};

#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    leptos::mount::hydrate_islands();
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::panic)]

    use super::*;

    const PAYROLL_RUN_SUMMARY_SCHEMA: &str =
        include_str!("../../rest/openapi/schemas/PayrollRunSummary.yaml");

    fn sample_run() -> RunSummary {
        RunSummary {
            id: "00000000-0000-0000-0000-000000000001".to_owned(),
            period_start: "2026-06-01".to_owned(),
            period_end: "2026-06-30".to_owned(),
            source_label: "workflow_runtime_m2:run:example".to_owned(),
            status: "BLOCKED_LEGAL_GATE".to_owned(),
            calculation_enabled: false,
            created_at: "2026-06-01T00:00:00Z".to_owned(),
            updated_at: "2026-06-01T00:00:00Z".to_owned(),
        }
    }

    fn yaml_required_keys(schema: &str) -> Vec<&str> {
        let mut keys = Vec::new();
        let mut in_required = false;
        for line in schema.lines() {
            let trimmed = line.trim();
            if trimmed == "required:" {
                in_required = true;
                continue;
            }
            if in_required {
                if let Some(key) = trimmed.strip_prefix("- ") {
                    keys.push(key);
                } else if trimmed.ends_with(':') {
                    break;
                }
            }
        }
        keys
    }

    #[test]
    fn empty_runs_match_unauthenticated_shell() {
        assert_eq!(render_shell_with(&[]), render_shell());
        assert!(
            !render_shell().contains("data-run-id"),
            "empty shell must omit run markup: {}",
            render_shell()
        );
        assert!(
            !render_shell().contains("/_ui/pkg/"),
            "empty shell must not load WASM: {}",
            render_shell()
        );
    }

    #[test]
    fn authorized_runs_carry_contract_keys_and_omit_won() {
        let html = render_shell_with(&[sample_run()]);
        let lowered = html.to_ascii_lowercase();
        assert!(
            html.contains("data-run-id=\"00000000-0000-0000-0000-000000000001\""),
            "{html}"
        );
        for key in yaml_required_keys(PAYROLL_RUN_SUMMARY_SCHEMA) {
            let attr = if key == "id" {
                "data-run-id".to_owned()
            } else {
                format!("data-{}", key.replace('_', "-"))
            };
            assert!(
                html.contains(&attr),
                "authorized markup must carry contract key {key} as {attr}: {html}"
            );
        }
        assert!(!lowered.contains("won"), "won leaked: {html}");
        assert!(!html.contains("291_520"), "golden won leaked: {html}");
        assert!(!lowered.contains("payslip"), "payslip leaked: {html}");
        assert!(
            html.contains("/_ui/pkg/hydrate.js"),
            "authorized markup must load the hydrate module: {html}"
        );
        let component = island_component(&html);
        assert!(
            component.starts_with("AuthorizedRuns_"),
            "island data-component must be the wasm-bindgen export: {html}"
        );
        let js = std::str::from_utf8(payroll_ui_js()).expect("bindgen js is utf-8");
        assert!(
            js.contains(&format!("export function {component}")),
            "committed bindgen js must export {component}"
        );
        assert_eq!(
            &payroll_ui_wasm()[..4],
            b"\0asm",
            "committed wasm must be a Wasm module"
        );
        assert!(
            hydrate_js().contains("/_ui/pkg/console_payroll_ui.js"),
            "hydrate.js must import bindgen js"
        );
        assert!(
            hydrate_js().contains("/_ui/pkg/console_payroll_ui_bg.wasm"),
            "hydrate.js must fetch the wasm module"
        );
        assert!(
            !render_shell().contains("AuthorizedRuns"),
            "empty shell must not emit an island: {}",
            render_shell()
        );
    }

    fn island_component(html: &str) -> &str {
        let marker = "data-component=\"";
        let start = html
            .find(marker)
            .unwrap_or_else(|| panic!("authorized markup must set data-component: {html}"));
        let rest = &html[start + marker.len()..];
        let end = rest
            .find('"')
            .unwrap_or_else(|| panic!("data-component must be quoted: {html}"));
        &rest[..end]
    }
}
