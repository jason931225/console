@testable import MaintenanceFieldApp
import Combine
import MaintenanceAPIClient
import MaintenanceFieldCore
import XCTest

@MainActor
final class FieldViewModelReportLifecycleTests: XCTestCase {
    func testConfirmedReportPublishesSuccessBeforeFailedTodayRefresh() async throws {
        let gateway = ControllableWorkOrderGateway(
            listError: URLError(.networkConnectionLost),
            listDelayNanoseconds: 100_000_000
        )
        let viewModel = makeViewModel(gateway: gateway)
        viewModel.selectedWorkOrder = workOrder
        viewModel.diagnosis = "Resolved"
        viewModel.actionTaken = "Replaced"
        var messages: [String?] = []
        var loading: [Bool] = []
        let messageToken = viewModel.$messageKey.sink { messages.append($0) }
        let loadingToken = viewModel.$isLoading.sink { loading.append($0) }
        defer { _ = (messageToken, loadingToken) }

        let submission = Task { await viewModel.submitReport() }
        let deadline = Date().addingTimeInterval(1)
        while await gateway.refreshStarted() == false && Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let didStartRefresh = await gateway.refreshStarted()
        XCTAssertTrue(didStartRefresh)

        XCTAssertEqual(viewModel.selectedWorkOrder?.status, .reportSubmitted)
        XCTAssertEqual(viewModel.selectedWorkOrder?.syncState, .synced)
        XCTAssertEqual(viewModel.messageKey, "report_submitted")
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertTrue(loading.suffix(3).elementsEqual([true, false, true]))

        await submission.value

        XCTAssertTrue(messages.contains("report_submitted"))
        XCTAssertEqual(viewModel.messageKey, "error_network")
        XCTAssertTrue(loading.suffix(4).elementsEqual([true, false, true, false]))
    }

    func testQueuedReportNeverPublishesConfirmedSuccess() async throws {
        let gateway = ControllableWorkOrderGateway(reportError: URLError(.timedOut))
        let viewModel = makeViewModel(gateway: gateway)
        viewModel.selectedWorkOrder = workOrder
        viewModel.diagnosis = "Resolved"
        viewModel.actionTaken = "Replaced"

        await viewModel.submitReport()

        XCTAssertEqual(viewModel.selectedWorkOrder?.status, .inProgress)
        XCTAssertEqual(viewModel.selectedWorkOrder?.syncState, .pending)
        XCTAssertEqual(viewModel.messageKey, "offline_queued")
        XCTAssertFalse(viewModel.isLoading)
    }

    func testRejectedReportPreservesFailureState() async throws {
        let gateway = ControllableWorkOrderGateway(reportError: MaintenanceGatewayError.apiResponse(operation: "submit", statusCode: 422))
        let viewModel = makeViewModel(gateway: gateway)
        viewModel.selectedWorkOrder = workOrder
        viewModel.diagnosis = "Resolved"
        viewModel.actionTaken = "Replaced"

        await viewModel.submitReport()

        XCTAssertEqual(viewModel.selectedWorkOrder?.status, .inProgress)
        XCTAssertEqual(viewModel.messageKey, "operation_failed")
        XCTAssertFalse(viewModel.isLoading)
    }

    private func makeViewModel(gateway: ControllableWorkOrderGateway) -> FieldViewModel {
        let queue = OfflineQueueRepository(store: InMemoryMutationQueueStore(), syncGateway: gateway, deviceIDProvider: { "test-device" })
        let repository = WorkOrderRepository(gateway: gateway, cache: WorkOrderCacheStore(), offlineQueue: queue)
        let live = FieldAppContainer.live()
        return FieldViewModel(container: FieldAppContainer(
            authRepository: live.authRepository,
            workOrderRepository: repository,
            evidenceRepository: live.evidenceRepository,
            messengerRepository: live.messengerRepository,
            locationConsentRepository: live.locationConsentRepository,
            mobileOperationsRepository: live.mobileOperationsRepository,
            passkeyStepUpRepository: live.passkeyStepUpRepository
        ))
    }

    private var workOrder: TechnicianWorkOrder {
        TechnicianWorkOrder(id: "00000000-0000-0000-0000-000000000111", requestNo: "WO-1", managementNo: "EQ-1", modelName: "Model", customerName: "Customer", siteName: "Site", priority: .p2, status: .inProgress, resultType: .unknown, targetDueAt: nil, createdAt: .distantPast, updatedAt: .distantPast, assigneeNames: [], syncState: .synced)
    }
}

private actor ControllableWorkOrderGateway: WorkOrderGateway {
    let reportError: Error?
    let listError: Error?
    let listDelayNanoseconds: UInt64
    private var didStartRefresh = false

    init(
        reportError: Error? = nil,
        listError: Error? = nil,
        listDelayNanoseconds: UInt64 = 0
    ) {
        self.reportError = reportError
        self.listError = listError
        self.listDelayNanoseconds = listDelayNanoseconds
    }

    func listTodayWorkOrders() async throws -> [TechnicianWorkOrder] {
        didStartRefresh = true
        if listDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: listDelayNanoseconds)
        }
        if let listError { throw listError }
        return []
    }

    func refreshStarted() -> Bool { didStartRefresh }

    func getWorkOrderDetail(id: Components.Schemas.Uuid) async throws -> TechnicianWorkOrder { throw URLError(.unsupportedURL) }
    func startWorkOrder(id: Components.Schemas.Uuid) async throws { throw URLError(.unsupportedURL) }
    func submitReport(id: Components.Schemas.Uuid, draft: ReportDraft) async throws {
        if let reportError { throw reportError }
    }
    func replay(deviceID: String, request: Components.Schemas.SyncBatchRequest) async throws -> Components.Schemas.SyncBatchResponse {
        Components.Schemas.SyncBatchResponse(syncId: "sync", results: [])
    }
}
