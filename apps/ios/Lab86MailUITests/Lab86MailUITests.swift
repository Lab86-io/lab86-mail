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

            // Continue across the remaining root and sheet domains using the
            // same authenticated, server-backed launch. These checks avoid
            // destructive actions while proving each destination really
            // renders on the physical-device acceptance path.
            app.buttons["Open navigation"].tap()
            XCTAssertTrue(app.buttons["Areas"].firstMatch.waitForExistence(timeout: 3))
            app.buttons["Areas"].firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Areas"].waitForExistence(timeout: 5))

            app.buttons["Open navigation"].tap()
            XCTAssertTrue(app.buttons["All"].firstMatch.waitForExistence(timeout: 3))
            app.buttons["All"].firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Mail"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.searchFields["Search this inbox"].exists)

            let activityButton = app.buttons
                .matching(NSPredicate(format: "label BEGINSWITH %@", "Activity"))
                .firstMatch
            XCTAssertTrue(activityButton.waitForExistence(timeout: 3))
            activityButton.tap()
            XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
            app.buttons["Done"].tap()

            app.buttons["Open navigation"].tap()
            XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 3))
            app.buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.staticTexts["Sending"].exists)

            let settingsScreenshot = XCTAttachment(screenshot: app.screenshot())
            settingsScreenshot.name = "Authenticated settings"
            settingsScreenshot.lifetime = .keepAlways
            add(settingsScreenshot)
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
