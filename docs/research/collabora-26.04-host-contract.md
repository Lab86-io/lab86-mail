# Collabora Online 26.04.3.2 host contract

Source: upstream mirror tag cp-26.04.3-2 (commit cc5614c67e8de6450d98a0e125814305df650b64). Compiled 2026-09-15 for the Albatross editor plan. Facts only; decisions live in docs/albatross-editor-milestone-a-2026-09-15.md.

# Collabora Online 26.04.3.2 host-integration contract (from upstream source)

## A. Ref used

- The GitHub repository `CollaboraOnline/online` no longer holds source. Its `main` branch has only `docker/`, `kubernetes/` and README files. The README says development moved to Gerrit and that `CollaboraOnline/online.mirror` is a read-only source mirror.
- `CollaboraOnline/online` has no 26.04 tags or branches (newest: `cp-25.04.9-5`, `distro/collabora/co-25.04`).
- `CollaboraOnline/online.mirror` has branch `distro/collabora/co-26.04` (head `ffe88ddf422fcfa093dc2bf2a82e1dc3c9ab36e5`) and tags `cp-26.04.1-1` ... `cp-26.04.4-1`.
- Ref used: tag **`cp-26.04.3-2`** in `CollaboraOnline/online.mirror`. The annotated tag object is `70b71911b6bb77eceb9cc86d4e3fa3edc12d2d6e` (tagged 2026-08-29). It points to commit **`cc5614c67e8de6450d98a0e125814305df650b64`**.
- All raw files were read from `https://raw.githubusercontent.com/CollaboraOnline/online.mirror/cp-26.04.3-2/<path>`.
- Path changes versus older releases: `browser/src/control/Control.UIManager.ts` (was `.js`), `browser/src/control/Control.Menubar.ts` (was `.js`), `browser/src/app/Socket.ts` (was `browser/src/core/Socket.js`), `wsd/FileServerUtil.cpp` holds the `ui_defaults` and `css_variables` parsers.

## B. Host -> editor postMessage MessageIds (browser/src/map/handler/Map.WOPI.js)

Listener: `_postMessageListener` (lines 402-990). Message format: `e.data` is a JSON string (or an object that already has `MessageId`). Fields: `MessageId`, `Values`.

Gating (in order):
1. Origin check `_allowMessageOrigin` (347-400). See section I.
2. `Close_Session` is handled at once (426-429).
3. The UI-modification group (432-634) is handled before `Host_PostmessageReady`.
4. Everything after line 637 needs `window.WOPIPostmessageReady` (set in `browser/js/global.js` 493-497 when the host sends `Host_PostmessageReady`).
5. `Grab_Focus`, `Close_Session`, `Get_User_State` work before `Document_Loaded` (647-666).
6. All other messages need `_appLoaded` (669-672), which is set after `App_LoadingStatus` `Document_Loaded` (316-342).

### B1. Handled before Host_PostmessageReady

| MessageId | Values | What it does | Lines |
|---|---|---|---|
| `Close_Session` | none | Sends `closedocument` on the socket. | 426-429, 654-657 |
| `Show_Button` / `Hide_Button` / `Remove_Button` | `{id}` (required) | `uiManager.showButton(id, show)`. `Remove_Button` behaves as hide. Ids: classic top-toolbar item ids and notebookbar item ids. Classic: `topToolbar.hasItem/showItem` (UIManager.ts 1411-1430). Notebookbar: `notebookbar.showItem/hideItem` fires a `jsdialogaction` `show`/`hide` for `control_id` (Control.Notebookbar.js 844-870). Hidden ids are tracked in `hiddenButtons` and re-applied after a UI mode switch. Hiding `toggledarktheme` also hides `view-invertbackground-break` (1456-1459). Unknown id logs `Button with id ... not found`. | 432-445; UIManager.ts 1437-1460 |
| `Show_Command` / `Hide_Command` | `{id}` = a `.uno:` command | `uiManager.showCommand(cmd, show)`: classic menubar `showUnoItem/hideUnoItem` (Menubar.ts 3148-3178), notebookbar buttons by CSS class `uno<Name>` (Notebookbar.js 439-457), `.uno:EditAnnotation` also toggles the comment edit affordance. | 446-459; UIManager.ts 1520-1559 |
| `Remove_Statusbar_Element` | `{id}` | `statusBar.showItem(id, false)`. Marked `TODO: remove`. | 460-472 |
| `Show_Menubar` / `Hide_Menubar` | none | `uiManager.showMenubar()/hideMenubar()`; hides `.main-nav` and close button. `hideMenubar` is a no-op in notebookbar mode (`shouldUseNotebookbarMode`). | 473-480; UIManager.ts 1574-1615 |
| `Show_Ruler` / `Hide_Ruler` | none | Sends `.uno:ShowRuler` (show only), shows/hides H/V rulers, sets doc-type pref `ShowRuler`. | 481-488; UIManager.ts 1639-1670 |
| `Show_StatusBar` / `Hide_StatusBar` | none | Shows/hides status bar, sets pref `ShowStatusbar`. | 489-496; UIManager.ts 1812-1837 |
| `Collapse_Notebookbar` / `Extend_Notebookbar` | none | Hides/shows `#toolbar-row`; adds/removes class `tabs-collapsed`. | 497-504; UIManager.ts 1757-1780 |
| `Show_NotebookTab` / `Hide_NotebookTab` | `{id}` = tab name | `uiManager.showNotebookTab(id, show)`; tab names are the `name` of the tab (Writer: `File`, `Home`, `Insert`, `Layout`, `Review`, `Format`, `Form`, `Shape`, `Picture`, `Chart`, `View`, `Extensions`, `Help`, `Formula`; NotebookbarWriter.js 18-30, 34-125). Tab DOM id is `<name>-tab-label` (Notebookbar.js 236-246, 555-605). | 505-518; UIManager.ts 1782-1798 |
| `Show_Sidebar` | optional `{id}` in `Navigator`, `ModifyPage`, `CustomAnimation`, `MasterSlidesPanel` | Sends `.uno:<id>`; otherwise `.uno:SidebarDeck.PropertyDeck`. | 519-533 |
| `Hide_Sidebar` | none | Sends `.uno:SidebarHide`. | 534-537 |
| `Show_Menu_Item` / `Hide_Menu_Item` | `{id}` = menubar item id | `menubar.showItem/hideItem` (Menubar.ts 3081-3107). Fails with a console error in notebookbar mode (no menubar). | 538-563 |
| `Insert_Button` | `{id (required), imgurl, hint, label, unoCommand, accessKey, insertBefore, mobile, tablet}` | `uiManager.insertButton(values)`. Classic toolbar: inserted before `insertBefore` or `save`, `postmessage` is true when `unoCommand` is absent (UIManager.ts 1308-1344). Notebookbar: added to the shortcuts bar as `toolitem` with `text = label || hint`, `icon = imgurl`, `command = unoCommand` (prefixed with `.uno:` if missing), `accessKey`, `cssClass: integrator-shortcut` (Notebookbar.js 412-437). `tablet: false` skips tablets (1384). Click without `unoCommand` emits `Clicked_Button {Id}`. | 564-568 |
| `Insert_ContextualButton` | `{id, ...}` | `contextToolbar.insertAdditionalContextButton(values)`. Click emits `Clicked_ContextualButton {Id}` (JSDialogBuilder.js 1769-1773). | 569-573 |
| `Send_UNO_Command` | `{Command (required), Args (optional)}` | `map.sendUnoCommand(Command, Args || '')` -> socket `uno <Command> <JSON.stringify(Args)>` (Toolbar.js 292-379, wire send at 374). `Args` is the LOK JSON argument object (e.g. `{"Hyperlink.Text":{"type":"string","value":"x"}}`). Special cases: `.uno:InsertAnnotation` / `.uno:InsertThreadedComment` without Args start interactive insertion; with `Args.InteractiveAnchor` truthy they run the anchor picker. In read-only mode only an allow-list of commands is sent (317-352). Blocked while a dialog is open (369-372). No reply message. | 574-601 |
| `Hint_OnscreenKeyboard` / `Hint_NoOnscreenKeyboard` | none | `window.keyboard.hintOnscreenKeyboard(true/false)`. | 602-609 |
| `Disable_Default_UIAction` | `{action, disable}` | Sets `map._disableDefaultAction[action]`. Actions honored: `UI_Save` (docdispatcher.ts 51, 132; Menubar.ts 2514; NotebookbarBuilder.js 757), `UI_Close` (docdispatcher.ts 79), `UI_Hyperlink` (Map.WOPI.js 112). | 610-621 |
| `Error_Messages` | `{list: [{type, msg}]}` | Overrides strings in `errorMessages`, `errorMessages.storage`, `errorMessages.uploadfile`. (No `return`; falls through to the ready check.) | 622-634 |

### B2. Need Host_PostmessageReady (line 637)

| MessageId | Values | What it does | Lines |
|---|---|---|---|
| `Host_PostmessageReady` | none | Ignored here; `global.js` 483-498 sets `window.WOPIPostmessageReady = true`. | 642-645 |
| `Grab_Focus` | none | Reactivates idle handler and focuses the map. | 647-651 |
| `Get_User_State` | none | Replies `Get_User_State_Resp {State: 'idle'|'active', Elapsed}`. Works before `Document_Loaded`. | 660-666 |

### B3. Need Document_Loaded (`_appLoaded`, line 669)

| MessageId | Values | What it does | Lines |
|---|---|---|---|
| `Set_Settings` | `{AlwaysActive}` | Sets `map.options.alwaysActive`. | 674-679 |
| `Get_Views` | none | Replies `Get_Views_Resp` (array of views, see C). | 680-682 |
| `Reset_Access_Token` | `{token, ttl?}` | Sends `resetaccesstoken <token> <ttl>`; resets expiry timer. | 683-692 |
| `Action_Save` | `{DontTerminateEdit?, DontSaveIfUnmodified?, ExtendedData?, Notify?}` | `map.save(...)`. `Notify: true` is required for `Action_Save_Resp` to be posted (filtered at 1186-1192). | 693-701 |
| `Action_Close` | none | `map.remove()`. | 702-704 |
| `Action_Fullscreen` | none | Toggles browser fullscreen. | 705-707 |
| `Action_FullscreenPresentation` | `{StartSlideNumber?}` or `{CurrentSlide?}` | Starts slideshow (presentation docs only). | 708-723 |
| `Action_Print` | none | `map.print()`. Blocked by `DisablePrint` (Toolbar.js 146-150). | 724-726 |
| `Action_Export` | `{Format, Notify?}` | `map.downloadAs('<basename>.<Format>', Format)`. Blocked by `DisableExport`. | 727-736 |
| `Action_InsertGraphic` | `{url}` | `map.insertURL(url, 'graphicurl')`. | 737-741 |
| `Action_InsertMultimedia` | `{url}` | `map.insertURL(url, 'multimediaurl')`. | 742-746 |
| `Action_CompareDocuments` | `{url, filename?}` | `map.insertURL(url, 'comparedocumentsurl')`. | 747-756 |
| `Action_InsertLink` | `{url, text?}` | Sends `.uno:SetHyperlink` with `Hyperlink.Text`, `Hyperlink.URL`, `Hyperlink.TextIsHint=true`. | 757-781 |
| `Action_GetLinkPreview_Resp` | preview object | Updates the URL popup preview (reply to `Action_GetLinkPreview`). | 782-786 |
| `Action_InsertFile` | `{File: Blob}` | Fires `insertfile`. | 787-791 |
| `Action_Paste` | `{Mimetype, Data}` | Sends a `paste mimetype=<Mimetype>\n<Data>` blob on the socket. | 792-797 |
| `Action_Copy` | `{Mimetype}` | Sends `gettextselection mimetype=<Mimetype>`; result posted as `Action_Copy_Resp {content}` (CanvasTileLayer.js 925-937). | 798-804 |
| `Action_ShowBusy` / `Action_HideBusy` | `{Label}` / none | Shows/hides the busy overlay. | 805-812 |
| `Get_Export_Formats` | none | Replies `Get_Export_Formats_Resp` `[ {Label, Format} ]`. | 813-823 |
| `Get_Comments` | none | Replies `Get_Comments_Resp {Comments: [{Id, Author, DateTime, Text, Resolved?, Parent?, Threaded?}]}`. | 824-868 |
| `Action_SaveAs` | `{Filename (with extension), Notify?}` | `pdf`/`epub` -> `exportAs`; else `saveAs(Filename, format)`. | 869-892 |
| `Action_FollowUser` | `{Follow, ViewId}` or none | `map._setFollowing(...)`. | 893-900 |
| `Host_VersionRestore` | `{Status: 'Pre_Restore'}` | Sends `versionrestore prerestore`; server acks with `App_VersionRestore {Status: 'Pre_Restore_Ack'}` (Socket.ts 2187-2195). | 901-905 |
| `CallPythonScript` | top-level `ScriptFile`, `Function`, `Values` | Sends `vnd.sun.star.script:<ScriptFile>$<Function>?language=Python&location=share`; result posted back to `e.source` as `CallPythonScript-Result` (CanvasTileLayer.js 2329-2336). | 906-911 |
| `Action_RemoveView` | `{ViewId}` | Sends `removesession <ViewId>`. | 912-916 |
| `Action_ChangeUIMode` | `{Mode: 'classic'|'notebookbar'}` | `uiManager.onChangeUIMode({mode, force: true})`. Other values are ignored (UIManager.ts 1252-1253). Replies `Action_ChangeUIMode_Resp {Mode}`. | 917-919 |
| `Action_Mention` | `{list}` | `mention.openMentionPopup(list)` (reply to `UI_Mention` autocomplete). | 920-923 |
| `Action_ResolveComment` | `{Id}` | Resolves a comment (text, spreadsheet, drawing). | 924-937 |
| `Action_GoToComment` | `{Id}` | Navigates to a comment; replies `Action_GoToComment_Resp {Id, success, errorMsg?}`. | 938-955, 1161-1169 |
| `Action_GoToPage` | `{Page}` (1-based) | Goes to page/part; replies `Action_GoToPage_Resp {Page, success, PageCount, errorMsg?}`. | 956-982, 1171-1179 |
| (no MessageId; `sender === 'EIDEASY_SINGLE_METHOD_SIGNATURE'`) | esign popup payload | `eSignature.handleSigned(msg)`. | 983-989 |

Not present in 26.04.3.2 (grep of `MessageId ===` in Map.WOPI.js and all of browser/src, browser/html, browser/js): `Action_Load`, `Action_ShowVersionHistory`, `Set_Notebookbar`, `Set_Theme`, `Action_ChangeTheme`, `Get_State`, `Get_Selection`, `Action_Rename`, `Action_Share`. There is no host->editor message that changes the theme.

## C. Editor -> host messages

Transport: every message goes through `L.Map.WOPI._postMessage` (Map.WOPI.js 1181-1201). Envelope: `JSON.stringify({MessageId, SendTime: Date.now(), Values})` sent with `window.parent.postMessage(msg, this.PostMessageOrigin)`. Sent only when `PostMessageOrigin` is non-empty and `window.parent !== window.self` (1185). `Action_Save_Resp` is dropped unless the last `Action_Save`/`Action_Export`/`Action_SaveAs` had `Notify: true` (1186-1192).

| MessageId | Values | Trigger | Source |
|---|---|---|---|
| `App_LoadingStatus` | `{Status: 'Initialized'}` | Map created | Map.js 360-365 |
| `App_LoadingStatus` | `{Status: 'Frame_Ready', Features: {VersionStates: true}}` | `wopi:` props received | Map.WOPI.js 253-263 |
| `App_LoadingStatus` | `{Status: 'Document_Loaded', DocumentLoadedTime}` | docloaded + updatepermission + viewinfo + initializedui | Map.WOPI.js 265-273, 316-342 |
| `App_LoadingStatus` | `{Status: 'Failed'}` | `loadstorage: failed` | Socket.ts 2043-2051 |
| `Doc_Title` | `{Title, DocName, DocType, ProductName}` | Title change | Map.WOPI.js 228-236 |
| `Doc_ModifiedStatus` | `{Modified: bool}` | `commandstatechanged` for `.uno:ModifiedStatus` | Map.js 284-296 |
| `Doc_PartChanged` | `{Part, PartCount, DocType}` | part/page change | Map.js 252-257 |
| `Action_Load_Resp` | `{success:false, errorType, errorMsg, result:''}` or `{success, result, errorMsg}` | load failure / `commandresult: load` / websocket unauthorized | Socket.ts 562-571, 2095-2104, 2340-2349 |
| `Action_Save_Resp` | `{success, result?, errorMsg?, fileName?, cmd?}` | `.uno:Save` commandresult; saveas/exportas/downloadas results and errors | Control.Toolbar.js 1004-1028; Socket.ts 1480-1489, 1857-1864, 2083-2094, 2255-2262, 2319-2322 |
| `Action_ChangeUIMode_Resp` | `{Mode}` | after UI mode switch | UIManager.ts 1257 |
| `Action_Copy_Resp` | `{content}` | reply to `Action_Copy` | CanvasTileLayer.js 929-935 |
| `Action_GoToComment_Resp` | `{Id, success, errorMsg?}` | reply to `Action_GoToComment` | Map.WOPI.js 1161-1169 |
| `Action_GoToPage_Resp` | `{Page, success, PageCount, errorMsg?}` | reply to `Action_GoToPage` | Map.WOPI.js 1171-1179 |
| `Action_GetLinkPreview` | `{url}` | link popup, when `EnableRemoteLinkPicker` | URLPopUpSection.ts 42-43 |
| `Get_Views_Resp` / `Views_List` | `[ {ViewId, UserName, UserId, UserExtraInfo, Color, ReadOnly, IsCurrentView} ]` | reply to `Get_Views` / on `updateviewslist` | Map.WOPI.js 90, 1203-1218 |
| `View_Added` | `{Deprecated: true, ViewId, UserId, UserName, UserExtraInfo, Color, ReadOnly}` | view joins | Map.js 448-453 |
| `View_Removed` | `{Deprecated: true, ViewId}` | view leaves | Map.js 461-465 |
| `FollowUser_Changed` | `{FollowedViewId, IsFollowUser, IsFollowEditor}` | follow state change | Map.js 1822-1825 |
| `Get_User_State_Resp` | `{State, Elapsed}` | reply to `Get_User_State` | Map.WOPI.js 660-666 |
| `Get_Export_Formats_Resp` | `[ {Label, Format} ]` | reply | Map.WOPI.js 813-823 |
| `Get_Comments_Resp` | `{Comments: [...]}` | reply | Map.WOPI.js 824-868 |
| `App_TokenExpiring` | `{Timeout}` ms | token about to expire | Socket.ts 751-760 |
| `App_TokenExpired` | `{}` | server `tokenexpired` | Socket.ts 1316-1322 |
| `App_VersionRestore` | `{Status: 'Pre_Restore_Ack'}` | server ack | Socket.ts 2187-2195 |
| `Session_Closed` | `{Reason, ...}` | server closed session with a reason | Socket.ts 2230-2236 |
| `Reloading` | `{Reason: 'Reconnected'}` | auto reload | Socket.ts 1919-1923 |
| `File_Rename` | `{NewName}` | after rename | Socket.ts 1815-1824 |
| `Download_As` | `{Type, URL, filename}` | download when `DownloadAsPostMessage` | CanvasTileLayer.js 1686-1688 |
| `UI_Save` | `{source: 'toolbar'|'filemenu'|...}` or none | save action | docdispatcher.ts 47-50, 131; Menubar.ts 2512; NotebookbarBuilder.js 756 |
| `UI_Close` | `{EverModified}` | close action | docdispatcher.ts 74-77 |
| `close` | `{EverModified, Deprecated: true}` | close action (legacy) | docdispatcher.ts 70-73 |
| `UI_CreateFile` | `{DocumentType}` | new-document action or Ctrl+Alt+N | Menubar.ts 1941; Map.Keyboard.js 803 |
| `UI_OpenDocument` | none | Ctrl+Alt+O | Map.Keyboard.js 817 |
| `UI_FileVersions` | none | revision history | Toolbar.js 837 |
| `rev-history` | `{Deprecated: true}` / none | revision history (legacy) | Toolbar.js 836; BackstageView.ts 1112 |
| `UI_Share` | none | share action (needs `EnableShare`; also needs `WOPIPostmessageReady`, Toolbar.js 841-851) | Toolbar.js 852; BackstageView.ts 1107 |
| `UI_SaveAs` | `{format}` | Save As | Toolbar.js 856 |
| `UI_InsertGraphic` | none | remote image (`EnableInsertRemoteImage`) | Menubar.ts 2574; docdispatcher.ts 206; ContentControlSection.ts 85 |
| `UI_InsertFile` | `{callback: 'Action_InsertMultimedia'|'Action_CompareDocuments', mimeTypeFilter}` | remote file (`EnableInsertRemoteFile`) | Menubar.ts 2578-2582; docdispatcher.ts 142-148, 155-161 |
| `UI_PickLink` | none | remote link picker | docdispatcher.ts 110 |
| `UI_InsertAIContent` | none | remote AI content | docdispatcher.ts 113 |
| `UI_Mention` | `{type: 'autocomplete', text}` / `{type: 'selected', username, label}` | @mention | Control.Mention.ts 59-62, 331-334 |
| `UI_Paste` | none | paste needs host help | Clipboard.js 799 |
| `UI_Hyperlink` | `{Url, Name, Features}` | `window.open` override | Map.WOPI.js 104-111 |
| `UI_Cancel_Password` | none | password dialog cancelled | Socket.ts 1784 |
| `UI_ZoteroKeyMissing` | none | Zotero key missing | Control.Zotero.js 139 |
| `Clicked_Button` | `{Id}` | custom button (no `unoCommand`) or menu item with `postmessage` | JSDialogBuilder.js 1769-1773; Menubar.ts 2682-2683 |
| `Clicked_ContextualButton` | `{Id}` | custom contextual button | JSDialogBuilder.js 1770-1772 |
| `Clicked_Comment` | `{Id}` | comment clicked | CommentListSection.ts 1119-1122 |
| `Inserted_Comment` | `{Id, Type, Parent, Author, DateTime, Text}` | comment inserted | CommentListSection.ts 2085-2094 |
| `User_Active` / `User_Idle` | none | idle handler | Control.IdleHandler.ts 176, 229 |
| `CallPythonScript-Result` | `{MessageId, SendTime, Values: <result>}` | sent directly to `e.source` with origin `'*'` | CanvasTileLayer.js 2329-2336 |

Not host messages: the `Extension_*` ids (`Extension_Call`, `Extension_CallResult`, `Extension_ProxyCall`, `Extension_DocumentEvent`, ...) go between COOL and an extension iframe via `_postToIframe` (Control.Extension.ts 13-97, 214-220), not to the WOPI host.

**Formatting / selection state is never reported to the host.** Evidence:
- The full list of `msgId:` literals in `browser/src`, `browser/html`, `browser/js` (grep `msgId:\s*'...'`) is the table above. No id carries bold/italic/font/paragraph style/undo/redo state.
- Core `statechanged:` messages are parsed in `CanvasTileLayer.js` `_onStateChangedMsg` (2265-2310) and fired as the internal map event `commandstatechanged` (2282, 2304). The only external forwarding is `window.postMobileMessage('COMMANDSTATECHANGED ...')` for the macOS and Qt native apps (2283-2285), not `window.parent.postMessage`.
- The only `commandstatechanged` listener that posts to the host is Map.js 284-296, and it only handles `.uno:ModifiedStatus` (-> `Doc_ModifiedStatus`).
- State values are kept client-side in `L.Map.StateChangeHandler._items` (Map.StateChanges.js 12-181, `getItemValue` 163-167) and consumed by toolbars/notebookbar/sidebar widgets.

## D. ui_defaults

Source: URL query parameter `ui_defaults` on the `cool.html` request. Read by `UserRequestVars` (`wsd/FileServer.cpp` 1423, `extractVariable(form, "ui_defaults", UI_DEFAULTS)`; the value is percent-encoded via `Uri::encode(value, "'")`). Converted by `FileServerRequestHandler::uiDefaultsToJSON` (`wsd/FileServerUtil.cpp` 190-336), base64-encoded, substituted for `%UI_DEFAULTS%` (FileServer.cpp 1553-1554) into `data-ui-defaults` of `#initial-variables` (cool.html.m4 319), decoded to `window.uiDefaults` (global.js 459).

Format: `key=value` pairs separated by `;` (tokenize on `;` then `=`; FileServerUtil.cpp 206-209).

Keys the 26.04 parser accepts (FileServerUtil.cpp lines):
| Key | Accepted values | Effect | Lines |
|---|---|---|---|
| `UIMode` | `compact` or `classic` -> `classic`; `tabbed` or `notebookbar` -> `notebookbar`; anything else logs `unknown UIMode value` | JSON `uiMode`; also `%USER_INTERFACE_MODE%` | 214-230 |
| `UITheme` | `dark` -> `darkTheme: "true"`; any other value -> `darkTheme: "false"` | JSON `darkTheme`; `%UI_THEME%` gets the raw value | 233-242 |
| `SavedUIState` | `true` / `false` (other values log an error and mean `true`) | `%SAVED_UI_STATE%` -> `window.savedUIState` | 243-257 |
| `SaveAsMode` | `group` only | JSON `saveAsMode` (used by `prefs.get('saveAsMode') === 'group'`, NotebookbarWriter.js 161) | 258-265 |
| `TouchscreenHint` | any string | JSON `touchscreenHint` | 266-270 |
| `OnscreenKeyboardHint` | any string | JSON `onscreenKeyboardHint` (global.js 1237) | 271-275 |
| `Text<Widget>`, `Spreadsheet<Widget>`, `Presentation<Widget>`, `Drawing<Widget>` with `<Widget>` in `Ruler`, `Sidebar`, `Statusbar`, `Toolbar` | `false`, `False`, `0` -> `"false"`; everything else -> `"true"` | JSON `{text|spreadsheet|presentation|drawing: {Show<Widget>: "true"|"false"}}`; other widget names log `unknown UI default` | 276-318 |

Examples that parse: `UIMode=classic;TextRuler=false;TextSidebar=false;SpreadsheetStatusbar=false;PresentationToolbar=false;UITheme=dark;SavedUIState=false;SaveAsMode=group;OnscreenKeyboardHint=true`.

Consumption on the client (global.js): `prefs._getUIDefault(key)` walks dotted keys such as `text.ShowRuler` (990-1011). `prefs.get(key)` order (1013-1053): runtime cache -> if `!savedUIState` and a ui default exists, the ui default wins -> server-stored browser setting -> localStorage -> ui default -> default value. So with `SavedUIState=true` (default) the user's saved state overrides ui_defaults; with `SavedUIState=false` ui_defaults override saved state. Widgets read these through `uiManager.getBooleanDocTypePref('ShowRuler'|'ShowSidebar'|'ShowStatusbar'|'ShowToolbar', ...)` (UIManager.ts 782, 1000, 1050, 3111-3114; Control.StatusBar.js 425-430). `ShowToolbar=false` collapses the notebookbar (UIManager.ts 782-784).

UI mode resolution: FileServer.cpp 1633-1650: config `user_interface.mode` (`compact`->`classic`, `tabbed`->`notebookbar`) overrides the `UIMode` from `ui_defaults` when it is `classic` or `notebookbar`; `accessibility.enable=true` forces `notebookbar`; any other value defaults to `notebookbar`. Result -> `%USER_INTERFACE_MODE%` -> `window.userInterfaceMode` (global.js 446) -> `shouldUseNotebookbarMode()` (UIManager.ts 274-279), which also honours the persisted user pref `compactMode`.

Other places: the `darkTheme` URL parameter, when present on a non-desktop-app build, replaces `window.uiDefaults` with `{darkTheme: 'true'}` (global.js 402-413, `initializeViewMode`, called from `afterInitialization` after the constructor has read `data-ui-defaults` at 459). The server also honours `darkTheme=true` for the loading screen (FileServer.cpp 1657-1668).

## E. css_variables, theme, dark mode

**css_variables**: URL query parameter `css_variables`, read unencoded by `extractVariablePlain(form, "css_variables", CSS_VARS)` (FileServer.cpp 1425). Parsed by `cssVarsToStyle` (FileServerUtil.cpp 381-430): tokens separated by `;`, each token split on `=`, exactly one `=` per token, and each token must pass `isValidCss` (369-378): printable ASCII 0x20-0x7E only, and none of `< > { } & | \ " ^ ` ' $ [ ]`. Output is `:root{<name>:<value>;...}` base64-encoded and substituted for `<!--%CSS_VARIABLES%-->` (FileServer.cpp 1586) in the hidden input `#init-css-vars` (cool.html.m4 69). The client base64-decodes it, creates a `CSSStyleSheet`, calls `sheet.replace(text)` and pushes it to `document.adoptedStyleSheets` (global.js 242-252).

Exact wire format: `css_variables=--color-main-text=%23333;--color-primary=%230b87e7` (name `=` value, `;` separated; the `=` separator, not `:`). Any variable name is accepted; only the character rules apply.

**`--co-` variables**: the 26.04 browser stylesheets define no `--co-*` custom properties (grep of `--co-` in all 37 files of `browser/css` returns 0). The only reference in the client is a read of `--co-primary-element` in `browser/src/map/handler/Map.Feedback.js` 106, passed to the feedback iframe; it is never defined by COOL. The palette is defined in `browser/css/color-palette.css` (`:root`, light) and `browser/css/color-palette-dark.css` (`[data-theme='dark']`).

Custom properties defined in `browser/css` at this ref (from grep of `^--name:`):
`--aichat-accent --annotation-input-size --annotation-max-size --annotation-min-size --blue1-txt-primary-color --border-radius --border-radius-large --border-radius-s --brightness-stylesview --btn-color-colorpicker-size --btn-img-colorpicker-size --btn-img-size --btn-img-size-m --btn-img-size-s --btn-padding --btn-size --btn-size-m --btn-size-s --cell-cursor-selection-border-color --click-increment --color-accent-background --color-annotation-line --color-background-dark --color-background-darker --color-background-document --color-background-hover --color-background-lighter --color-background-slideshow --color-background-tabs-group --color-backstage-background --color-backstage-background-dark --color-black-10 --color-black-15 --color-black-20 --color-black-5 --color-border --color-border-calc-header --color-border-calc-header-sheetview --color-border-dark --color-border-dark-63 --color-border-darker --color-border-input --color-border-input-dark --color-border-lighter --color-box-shadow --color-box-shadow-dark --color-box-shadow-light --color-btn-border --color-btn-border-dis --color-btn-danger-bg --color-btn-danger-hover-bg --color-btn-danger-outline --color-btn-primary-hover-bg --color-calc-comment --color-calc-grid --color-calc-header --color-calc-header-hover --color-calc-header-selected --color-calc-header-sheetview --color-calc-header-sheetview-hover --color-calc-header-sheetview-selected --color-canvas --color-cursor-blink-background --color-date-text --color-error --color-grid-helper-line-dashed --color-grid-helper-line-solid --color-hyperlink --color-insert-marker-background --color-insert-marker-background-dark --color-main-background --color-main-text --color-on-primary --color-overlay --color-presenter-console-btn-hover --color-primary --color-primary-dark --color-primary-darker --color-primary-lighter --color-primary-text --color-quickfind-border --color-scrollbar-railway --color-scrollbar-thumb --color-slideshow --color-smart-guides-helper-line --color-status-badge --color-stylesview-background --color-stylesview-border --color-success --color-text-calc-header --color-text-calc-header-selected --color-text-calc-header-sheetview-selected --color-text-dark --color-text-darker --color-text-light --color-text-lighter --color-toolbar-border --color-treeview-highlight --color-treeview-highlight-text --color-warning --column-row-highlight --cool-font --cool-vertical-rail-width --default-font-size --default-height --default-width --doc-icon-url --doc-type-color --duration-deliberate --duration-fast --duration-instant --duration-normal --duration-slow --ease-in --ease-out --ease-standard --green0-txt-primary-color --header-font-size --header-height --icon-primary-color --icon-secondary-color --medium-font-size --notebookbar-element-height --opacity-icon-disabled --orange1-txt-primary-color --overflow-group-font-size --ruler-height --scrollbar-color --scrollbar-width --shadow-elevated --shadow-subtle --sidebar-header-height --spacing-l --spacing-m --spacing-s --spacing-xl --spacing-xs --tb-fs-s --tb-max-fs --tb-max-fs-u --tb-min-fs --tb-min-fs-u --tooltip-font-size --yellow0-txt-primary-color`

Key colour variables (color-palette.css 10-60): `--color-main-text`, `--color-main-background`, `--color-background-lighter` (toolbar/dialog), `--color-primary` (`#0b87e7`), `--color-primary-dark`, `--color-primary-darker`, `--color-primary-lighter`, `--color-primary-text`, `--color-border`, `--color-toolbar-border`, `--color-error`, `--color-warning`, `--color-success`. An adopted `:root{}` sheet from `css_variables` is appended last, so it overrides `color-palette.css` `:root` values; it does not override `[data-theme='dark']` values, which have higher specificity.

**`theme` URL parameter**: read as `extractVariable(form, "theme", BRANDING_THEME)` (FileServer.cpp 1429) -> `%BRANDING_THEME%` -> `#init-branding-name` (cool.html.m4 77). `updateThemeResources` (FileServer.cpp 3152-3223): the value is sanitized to `[A-Za-z0-9_-]`; if the directory `<FileServerRoot>/browser/dist/<theme>` exists and config `user_interface.use_integration_theme` is true (default true), the `branding.css` and `branding.js` links become `<theme>/branding.css|js` and `%USE_INTEGRATION_THEME%` becomes `true`. The client then also loads `<theme>/branding-desktop.css|branding-tablet.css|branding-mobile.css` (global.js 376-391). So `theme` selects a server-side branding directory; it does not load a named CSS file for CSS variables.

**`ui_theme` URL parameter** (FileServer.cpp 1446, 1965-1967): `%UI_THEME%`; used in the iOS `<html>` template (cool.html.m4 28) and the welcome template. In the browser `cool.html` path `%UI_THEME%` is set from `ui_defaults` `UITheme` (1555) and appears nowhere in the browser branch of the template.

**Dark mode**: 
- URL param `darkTheme=true`: server adds ` data-theme="dark"` to `<html>` and a `<link>` to `color-palette-dark.css` (FileServer.cpp 1657-1668); client sets `uiDefaults = {darkTheme:'true'}` (global.js 402-413).
- `ui_defaults=UITheme=dark` -> `darkTheme` ui default (FileServerUtil.cpp 233-242).
- Runtime: `uiManager.toggleDarkMode()` / `applyDarkMode(dark, persist)` (UIManager.ts 391-420) set `document.documentElement` `data-theme` to `dark`/`light` (286-299), fire `commandstatechanged` `toggledarktheme`, and send `.uno:ChangeTheme {NewTheme: 'Dark'|'Light'}` to core (539-543). The pref key is `darkTheme`; when unset it follows `prefers-color-scheme` (global.js 1182-1190). The toolbar button id is `toggledarktheme` (hideable via `Hide_Button`, UIManager.ts 1456-1459).
- There is no postMessage to set the theme at runtime. A host can only use `Send_UNO_Command` with `.uno:ChangeTheme` (affects the core render only, not the `data-theme` attribute) or the URL/ui_defaults options above.

Every URL query parameter `FileServer.cpp` reads for `cool.html` (`UserRequestVars`, 1380-1466, plus `preprocessFile`): `access_token`, `access_token_ttl`, `no_auth_header`, `access_header`, `ui_defaults`, `css_variables`, `postmessage_origin`, `theme`, `checkfileinfo_override` (only key `DownloadAsPostMessage`, FileServerUtil.cpp 338-365), `buy_product`, `permission`, `configid` (debug builds), `wopi_setting_base_url`, `iframe_type`, `ui_theme`, `host_session_id`, `WOPISrc` (1786-1809, frame-ancestors), `lang` (1653), `darkTheme` (1661).

URL query parameters the browser reads itself via `coolParams.get` (global.js 337-364 and callers): `welcome`, `userinterfacemode`, `lang`, `userid`, `timestamp`, `startreadonly`, `starterMode`, `startPresentation`, `randomUser`, `file_path`, `WOPISrc`, `vector`, `target`, `simulateError`, `revisionhistory`, `presentationLeaderId`, `permission`, `dir`, `debug`, `darkTheme`, `comparechanges`, `closebutton`, `alwaysactive`, `NotWOPIButIframe`. `closebutton` and `revisionhistory` become `L.Params.closeButtonEnabled` / `revHistoryEnabled` (global.js 874-880) and gate the close button and the revision-history menu entry (Menubar.ts 2838-2839; UIManager.ts 1579-1582).

## F. WOPI CheckFileInfo properties the browser honours

The server sends a `wopi: {...}` JSON to the client (`wsd/DocumentBroker.cpp` 1589-1691). The client stores it in `_setWopiProps` (Map.WOPI.js 138-201). Keys sent (DocumentBroker.cpp): `PostMessageOrigin` (if set), `BaseFileName`, `BreadcrumbDocName` (if set), `TemplateSaveAs`, `TemplateSource`, `HidePrintOption`, `HideSaveOption`, `HideExportOption`, `HideRepairOption`, `DisablePrint`, `DisableExport`, `DisableCopy`, `DisableInactiveMessages`, `DownloadAsPostMessage`, `UserCanNotWriteRelative`, `EnableInsertRemoteImage`, `EnableInsertRemoteFile`, `DisableInsertLocalImage`, `EnableRemoteLinkPicker`, `EnableRemoteAIContent`, `DisableAISettings`, `IsAnonymousUser`, `AIConfigured`, `AIModelName`, `AIEthicalRating`, `EnableShare`, `HideUserList`, `SupportsRename`, `UserCanRename`, `FileUrl`, `UserCanWrite`, `HideChangeTrackingControls` (if set), `IsOwner`, `PresentationLeader`, `DisablePresentation`, `CommentAvatarUrl`.

| Property | Effect in the browser | Evidence |
|---|---|---|
| `PostMessageOrigin` | Target origin for all editor->host messages. | Map.WOPI.js 141-143, 1199 |
| `BaseFileName`, `BreadcrumbDocName` | Document title, `Doc_Title`, rename UI, export file name. | Map.WOPI.js 145-149, 203-237; Control.DocumentNameInput.js |
| `HidePrintOption` | Hides `print` in menubar and notebookbar File tab. Server sets it when `DisablePrint` is true. | Menubar.ts 2845; NotebookbarWriter.js 157; DocumentBroker.cpp 1597-1598 |
| `DisablePrint` | `map.print()` returns early. | Toolbar.js 146-150 |
| `HideSaveOption` | Hides `save` menu entry, notebookbar save button and shortcuts-bar save; `save` action no-ops. | Menubar.ts 2848; Notebookbar.js 342; NotebookbarWriter.js 163; docdispatcher.ts 46 |
| `HideExportOption` | Hides `downloadas-*`, `export*`, `fullscreen-presentation*` entries and toolbar export items; server also sets it when `DisableExport`. Also feeds `DisablePresentation`. | Menubar.ts 2878, 2912, 2922; NotebookbarBuilder.js 324; Widget.Toolitem.ts 33; DocumentBroker.cpp 1599-1600, 1674 |
| `DisableExport` | `downloadAs` returns early for `export`. | Toolbar.js 146-150 |
| `HideRepairOption` | Hides `repair`. | Menubar.ts 2881; NotebookbarWriter.js 158 |
| `HideChangeTrackingControls` | Hides `changesmenu` and track-change buttons on comments. | Menubar.ts 2884; CommentSection.ts 232; ContextMenu.ts 424 |
| `DisableCopy` | Clipboard writes a stub instead of content; cell formula not copied. | Clipboard.js 987, 1283-1286; CanvasTileLayer.js 1516 |
| `DisableInactiveMessages` | Suppresses idle/inactive messages. | Control.IdleHandler.ts 42; Socket.ts 641, 1913 |
| `DownloadAsPostMessage` | Downloads become `Download_As` messages instead of navigation. Can also be forced with URL `checkfileinfo_override=DownloadAsPostMessage=true`. | CanvasTileLayer.js 1686-1688; Map.WOPI.js 159-160 |
| `UserCanNotWriteRelative` | Hides `saveas*`, `exportas*` entries and Save As in the notebookbar; affects rename fallback. | Menubar.ts 2851-2855; NotebookbarWriter.js 159; Map.WOPI.js 134-136 |
| `EnableInsertRemoteImage` | Adds `remotegraphic` entry to the Insert Image menu; menubar `insertgraphicremote`; emits `UI_InsertGraphic`. | Map.WOPI.js 290-292; Menubar.ts 2863; ContentControlSection.ts 82-85 |
| `EnableInsertRemoteFile` | Adds `remotemultimedia` and `remotecomparedocuments`; emits `UI_InsertFile`. | Map.WOPI.js 294-299; Menubar.ts 2875 |
| `DisableInsertLocalImage` | Empties the Insert Image / Multimedia / Compare menus; hides `insertgraphic`, `insertmultimedia`. | Map.WOPI.js 280-284; Menubar.ts 2869-2873 |
| `EnableRemoteLinkPicker` | Shows remote link picker entries; emits `UI_PickLink`, `Action_GetLinkPreview`. | Menubar.ts 2390; URLPopUpSection.ts 42-43 |
| `EnableRemoteAIContent` | Shows the remote AI content entry; emits `UI_InsertAIContent`. | Menubar.ts 2400; NotebookbarWriter.js 1377-1385 |
| `DisableAISettings`, `IsAnonymousUser`, `AIConfigured`, `AIModelName`, `AIEthicalRating` | AI entry points and settings iframe. | Map.WOPI.js 166-176; NotebookbarWriter.js 1816-1817; Map.Settings.ts 71 |
| `EnableShare` | Shows `shareas` in menubar, notebookbar options and File tab; emits `UI_Share`. | Menubar.ts 2860; Notebookbar.js 754; NotebookbarWriter.js 160; UIManager.ts 753 |
| `HideUserList` | Comma-separated list; `true`, `mobile`, `tablet`, `desktop` hide the user list on that form factor. | Map.WOPI.js 190-191; Control.UserList.ts 250-263 |
| `SupportsRename`, `UserCanRename` | `renamedocument` entry needs `(SupportsRename || !UserCanNotWriteRelative) && UserCanRename`; document name input editability. | Menubar.ts 2866; Map.WOPI.js 134-136; DocumentNameInput.js 36 |
| `UserCanWrite` | Sets permission `edit` (unless the URL `permission` says read-only). | Map.WOPI.js 185-186; Permission.js 74 |
| `IsOwner` | Disables `changepass` button for non-owners. | Widget.PushButton.ts 33-39 |
| `TemplateSaveAs` | Triggers an immediate `saveAs` after load. | Map.WOPI.js 195-198 |
| `TemplateSource` | Sent to the client but only used server-side (`template=` in the load command, ClientSession.cpp 2408-2410; upload 3386-3388). | DocumentBroker.cpp 1609-1610 |
| `DisablePresentation` | Server-computed: `DisableExport || HideExportOption` (or watermark with the old slideshow). Hides presentation entries. | DocumentBroker.cpp 1674-1677; Menubar.ts 1620; Map.SlideShow.js 301 |
| `PresentationLeader`, `CommentAvatarUrl` | Presentation leader view; avatar image URL. | Map.WOPI.js 182-183; UIManager.ts 895-897; CommentSection.ts 354 |

Server-only properties (never in the `wopi:` JSON; the browser does not read them): `EnableOwnerTermination` (ClientSession.cpp 953-955), `WatermarkText` (ClientSession.cpp 2367-2371, passed to core in the load command; DocumentBroker.cpp 1508, 1744), `IsAdminUser` (DocumentBroker.cpp 1511-1513, 1741; ClientSession.cpp 3604, 4462), `DisableChangeTrackingShow`, `DisableChangeTrackingRecord` (ClientSession.cpp 3106-3120).

## G. Observing Send_UNO_Command results

- `Send_UNO_Command` does not produce a reply message (Map.WOPI.js 574-601 returns after `sendUnoCommand`).
- The core answers some UNO commands with `commandresult:`; `CanvasTileLayer.js` `_onCommandResultMsg` fires the map event `commandresult` (2324). The only host messages that derive from `commandresult` are `Action_Save_Resp` for `.uno:Save` (Control.Toolbar.js 1004-1028) and `CallPythonScript-Result` when a `CallPythonScript` is pending (CanvasTileLayer.js 2329-2336). For `.uno:Save` the reply is also filtered by the `Notify` flag (Map.WOPI.js 1186-1192).
- Client-side `statechanged:` (LOK `STATE_CHANGED`): `CanvasTileLayer.js` 905-906 -> `_onStateChangedMsg` 2265-2310. JSON payloads (`{commandName, state|enabled}`) and `name=value` payloads both become the map event `commandstatechanged` (2282, 2304). `L.Map.StateChangeHandler` (Map.StateChanges.js 12-181) stores the last value per command in `_items`; toolbars call `getItemValue('.uno:Bold')` etc. Nothing forwards `commandstatechanged` to the host except `.uno:ModifiedStatus` -> `Doc_ModifiedStatus` (Map.js 284-296).
- There is no `Get_State`, `Get_Selection`, or generic query message. The nearest are `Action_Copy {Mimetype}` -> `Action_Copy_Resp {content}` (selection content only, Map.WOPI.js 798-804; CanvasTileLayer.js 925-937) and `Get_Comments`.

## H. Reload requirements

- `Action_ChangeUIMode` does not reload the document. `onChangeUIMode` (UIManager.ts 1243-1300) sets `data-userInterfaceMode` on `<body>`, posts `Action_ChangeUIMode_Resp`, removes one UI and builds the other (`removeNotebookbarUI`/`addClassicUI` or `removeClassicUI`/`addNotebookbarUI`), persists the pref `compactMode` (1273), re-inserts custom buttons (1275), and re-fires ruler/statusbar/darkmode events. It is a no-op on small-screen devices (1244-1245) and for any Mode other than `classic`/`notebookbar` (1252-1253). The host's `Hide_Button`/`Hide_Command`/`Hide_NotebookTab` choices persist across the switch because `hiddenButtons`/`hiddenCommands`/`hiddenTabs` are consulted when the new UI is built (1437-1443, 1520-1524, 1782-1798).
- `ui_defaults`, `css_variables`, `theme`, `darkTheme`, `postmessage_origin` and the other URL parameters are only evaluated when the server serves `cool.html` (`preprocessFile`, FileServer.cpp 1502-1830) and when `global.js` runs at page load (242-252, 402-413, 434-481). Changing them needs a new `cool.html` load in the iframe (a new browser session). The `wopi:` CheckFileInfo properties are sent once per document load (DocumentBroker.cpp 1691) and applied in `_setWopiProps`; a `Save As` reload (`resetAppLoaded`, Map.WOPI.js 304-314) refreshes them.

## I. PostMessageOrigin and origin checks

- Incoming (host -> editor) messages are accepted only when `_allowMessageOrigin` (Map.WOPI.js 347-400) passes: `e.origin` is not `'null'`; and it equals `window.parent.origin` (357-358), or matches one of `window.frameAncestors` (from the CSP `frame-ancestors` list the server computed: config `net.content_security_policy` frame-ancestors, the deprecated `net.frame_ancestors`, the coolwsd host, and the `WOPISrc` host; FileServer.cpp 1758-1821, cool.html.m4 303, global.js 457), or is in `window.location.ancestorOrigins` (Chrome), or is the e-signature popup origin. Otherwise the client logs `PostMessage not allowed due to incorrect origin.` and drops the message (403-405).
- Outgoing (editor -> host) messages use `this.PostMessageOrigin` (1199). Order: CheckFileInfo `PostMessageOrigin` (141-143) > URL parameter `postmessage_origin` (`%POSTMESSAGE_ORIGIN%` -> `data-post-message-origin-ext` -> `window.postMessageOriginExt`, FileServer.cpp 1427, 1558; cool.html.m4 313; global.js 439; Map.WOPI.js 20) > `'*'`. Messages are only sent inside an iframe (`window.parent !== window.self`, 1185).
- `Host_PostmessageReady` must arrive (global.js 483-498 listens on `window` `message`, parses JSON, sets `WOPIPostmessageReady`) before any message not in the pre-ready group is processed (Map.WOPI.js 637-640). `UI_Share` also needs the handshake (Toolbar.js 841-851). Most action messages additionally wait for `App_LoadingStatus` `Document_Loaded` (669-672).

## Files read at cp-26.04.3-2 (online.mirror)

`browser/src/map/handler/Map.WOPI.js`, `browser/src/control/Control.UIManager.ts`, `browser/src/control/Control.Toolbar.js`, `browser/src/control/Toolbar.js`, `browser/src/control/Control.NotebookbarBuilder.js`, `browser/src/control/Control.Notebookbar.js`, `browser/src/control/Control.NotebookbarWriter.js`, `browser/src/control/Control.Menubar.ts`, `browser/src/control/Control.StatusBar.js`, `browser/src/control/Control.TopToolbar.js`, `browser/src/control/Control.Extension.ts`, `browser/src/control/Control.JSDialogBuilder.js`, `browser/src/app/Socket.ts`, `browser/src/map/Map.js`, `browser/src/map/handler/Map.StateChanges.js`, `browser/src/layer/tile/CanvasTileLayer.js`, `browser/src/docdispatcher.ts`, `browser/js/global.js`, `browser/html/cool.html.m4`, `browser/css/*`, `wsd/FileServer.cpp`, `wsd/FileServer.hpp`, `wsd/FileServerUtil.cpp`, `wsd/DocumentBroker.cpp`, `wsd/ClientSession.cpp`, `wsd/wopi/WopiStorage.hpp`. Not found at this ref: `browser/src/core/Socket.js` (moved to `browser/src/app/Socket.ts`), `wsd/FileServerUtil.hpp`.
