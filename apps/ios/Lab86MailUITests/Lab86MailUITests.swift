import XCTest

final class Lab86MailUITests: XCTestCase {
    @MainActor
    func testLaunchesIntoConfigurationOrAuthenticationBoundary() {
        let app = XCUIApplication()
        app.launch()

        let navigationButton = app.buttons["Open navigation"]
        if navigationButton.waitForExistence(timeout: 10) {
            navigationButton.tap()
            XCTAssertTrue(app.staticTexts["Brief"].waitForExistence(timeout: 3))
            XCTAssertTrue(app.staticTexts["Areas"].exists)

            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "Authenticated navigation overlay"
            screenshot.lifetime = .keepAlways
            add(screenshot)

            // Source-list selection must actually navigate: tapping Tasks
            // closes the navigation layer and shows the board (titled by the
            // active board's name, so assert on the board switcher). Rows are
            // queried as buttons — page content can carry same-named text.
            app.buttons["Tasks"].firstMatch.tap()
            XCTAssertTrue(app.buttons["Boards"].waitForExistence(timeout: 5))

            app.buttons["Open navigation"].tap()
            XCTAssertTrue(app.buttons["Calendar"].firstMatch.waitForExistence(timeout: 3))
            app.buttons["Calendar"].firstMatch.tap()
            // The calendar titles itself with the visible month; assert on its
            // own affordance instead of a fixed bar title.
            XCTAssertTrue(app.buttons["New event"].waitForExistence(timeout: 5))

            // The floating create button offers intent capture, chat, and
            // compose; chat opens the full-page conversation.
            let createButton = app.buttons["New intent, chat, or email"]
            XCTAssertTrue(createButton.waitForExistence(timeout: 3))
            createButton.tap()
            XCTAssertTrue(app.buttons["New intent"].waitForExistence(timeout: 3))
            let newChat = app.buttons["New chat"]
            XCTAssertTrue(newChat.exists)
            newChat.tap()
            XCTAssertTrue(app.textFields["Message Albatross"].waitForExistence(timeout: 5))

            let chatScreenshot = XCTAttachment(screenshot: app.screenshot())
            chatScreenshot.name = "New chat conversation"
            chatScreenshot.lifetime = .keepAlways
            add(chatScreenshot)
        } else if app.staticTexts["Bring your inbox"].waitForExistence(timeout: 3) {
            XCTAssertTrue(app.buttons["Connect Gmail"].exists)
            XCTAssertTrue(app.buttons["Connect Microsoft"].exists)

            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "Mailbox onboarding boundary"
            screenshot.lifetime = .keepAlways
            add(screenshot)
        } else {
            XCTAssertTrue(app.navigationBars["Albatross"].waitForExistence(timeout: 10))
        }
    }
}
