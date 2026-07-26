import XCTest

/// Camera-capture UI states reached from the deterministic seeded work order.
/// CI-only.
final class CameraCaptureUITests: FieldUITestCase {
    func testCaptureSheetPresentsAGracefulRealStateOnSimulator() async throws {
        _ = try await launchApp()
        waitForAuthenticatedShell()
        try openSeededWorkOrder(fixtureKey: UITestFixture.cameraWorkOrderID)

        guard let capture = scrollToDetailElement(app.buttons[AID.detailCaptureEvidenceButton]) else {
            XCTFail("증빙 촬영 button should be reachable in the lazy detail form.")
            return
        }

        // Camera privacy is owned by SpringBoard, not the app process. Resolve
        // the reset-on-every-shard prompt through the owning process before
        // asserting any app-owned camera state; a missing prompt is a failure,
        // never an implicit pass into a pre-authorized simulator state.
        capture.tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let systemPermissionAlert = springboard.alerts.firstMatch
        guard systemPermissionAlert.waitForExistence(timeout: 5) else {
            XCTFail("The reset camera-permission prompt must be presented by SpringBoard.")
            return
        }

        let deny = ["Don’t Allow", "Don't Allow", "허용 안 함", "허용하지 않음"]
            .lazy
            .map { systemPermissionAlert.buttons[$0] }
            .first { $0.exists }
        guard let deny else {
            XCTFail("The SpringBoard camera-permission prompt must expose an explicit denial control.")
            return
        }
        deny.tap()
        XCTAssertTrue(
            systemPermissionAlert.waitForNonExistence(timeout: 5),
            "The SpringBoard camera-permission alert must resolve before app-owned controls are used."
        )

        // The Simulator can deterministically reach a preview, a denied or
        // unavailable state, or leave the system prompt pending. The app-owned
        // pending state is terminal only when it preserves the Cancel escape.
        let requesting = app.activityIndicators[AID.cameraPermissionRequesting]
        let denied = app.staticTexts[AID.cameraPermissionDenied]
        let shutter = app.buttons[AID.cameraShutterButton]
        var cancel = app.buttons[AID.cameraCancelButton]
        let unavailable = app.staticTexts[AID.cameraUnavailable]

        var reachedTerminalState = false
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            let previewIsUsable = shutter.exists && cancel.exists
            let pendingIsEscapable = requesting.exists && cancel.exists
            let deniedIsEscapable = denied.exists && cancel.exists
            let unavailableIsEscapable = unavailable.exists && cancel.exists
            if previewIsUsable {
                reachedTerminalState = true
                break
            }
            if pendingIsEscapable || deniedIsEscapable || unavailableIsEscapable {
                reachedTerminalState = true
                break
            }
            try await Task.sleep(for: .milliseconds(200))
        }

        guard reachedTerminalState else {
            XCTFail(
                "Camera capture must reach a bounded usable terminal state: preview with shutter+cancel, or pending/denied/unavailable with cancel."
            )
            return
        }

        // Reacquire after SpringBoard relinquishes focus: the app-owned sheet
        // must expose a hittable escape rather than relying on a stale query.
        cancel = app.buttons[AID.cameraCancelButton]
        XCTAssertTrue(cancel.exists, "Every camera terminal state must retain the Cancel escape.")
        XCTAssertTrue(cancel.isHittable, "The app-owned Cancel escape must be tappable after permission resolution.")
        cancel.tap()
        XCTAssertTrue(
            cancel.waitForNonExistence(timeout: 5),
            "Cancelling any usable camera terminal state must dismiss the camera sheet."
        )
        XCTAssertFalse(
            requesting.exists || denied.exists || unavailable.exists || shutter.exists,
            "No camera terminal controls should remain after cancelling the camera sheet."
        )
    }
}
