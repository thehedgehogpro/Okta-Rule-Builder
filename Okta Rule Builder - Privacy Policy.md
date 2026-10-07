# Privacy Policy for Okta Rule Builder (ORB)

**Last updated:** August 20, 2026

Okta Rule Builder ("ORB," "the extension") is a Chrome extension created by Tim McWeeny ("the Developer") to help Okta administrators build and test Group Rule expressions. This policy explains what data the extension touches and what it does with it.

## Summary

ORB does not collect, store, or transmit any personal data to its developer or to any third party. The extension runs entirely inside your browser and only communicates with the Okta organization you are already logged into, using your own active admin session.

## What ORB does

ORB adds a visual rule-builder and a rule-preview tool to the Okta Admin Console. It works only on pages within an Okta domain (`*.okta.com`, `*.okta-emea.com`, `*.oktapreview.com`, `*.okta-gov.com`, `*.okta.mil`). When you use it:

- The rule-builder UI converts your selections into Okta Expression Language entirely within your browser. No network request is made for this feature.
- The rule-preview feature sends requests to your own Okta organization's API (using the same origin and session you are already authenticated with) to list users and evaluate your expression against them, using Okta's own expression evaluator. This is the same data your admin account can already access directly in the Okta Admin Console.

## Data collection and storage

- ORB does not send any data to the Developer, to ORB's GitHub repository, or to any third-party server or analytics service.
- ORB does not use any browser storage (no `chrome.storage`, cookies, or local storage) to save your data. The extension requests no storage-related permissions.
- User profile data retrieved during a rule preview (names, usernames, and profile attributes) is held only in the browser's memory for the duration of that session and is discarded when the popup is closed or the page is refreshed.
- If you choose to export preview results as a CSV file, that file is generated and saved locally on your device. It is never uploaded anywhere by the extension.

## Permissions

ORB's manifest requests the `declarativeContent` permission, which is used only to show the extension's icon when you're on a supported Okta page. It also injects a content script on the Okta domains listed above so the "Open in Rule Builder" and "Preview OEL Rule" buttons can appear in the Group Rules interface. No browsing history, other tabs, or non-Okta pages are accessed.

## Requests to Okta

When you use the rule-preview feature, ORB calls Okta's own API endpoints (including an internal, undocumented expression-evaluation endpoint used by Okta's native rule preview) using `fetch` with your existing browser session and Okta's XSRF token, read from the page. These requests go directly from your browser to your Okta organization. Tim McWeeny and ORB have no access to these requests, their contents, or their responses.

## Third parties

ORB does not integrate with any third-party service, analytics platform, or advertising network.

## Children's privacy

ORB is a tool for Okta administrators and is not directed at children. It does not knowingly collect data from anyone.

## Changes to this policy

If ORB's data practices change in a future version, this policy will be updated accordingly, and the "Last updated" date above will reflect the change.

## Contact

Questions about this policy or ORB can be directed to the Developer, Tim McWeeny, by opening an issue on the [ORB GitHub repository](https://github.com/thehedgehogpro/Okta-Rule-Builder/).
