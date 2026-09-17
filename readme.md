# ORB (Okta Rule Builder) adds new user-friendly features to Group Rules via a Chrome plugin
1. Edit Okta Expression Language in a visual logic-builder UI
2. Run real-time tests against your expression and see which users match your expression.
...and more coming soon.

# Install the extension
**Option 1: Install from the Chrome Store**
- Just search 'ORB' or 'Okta Rule Builder' and you'll find it!
- This will also keep you up to date with new features as they roll out.

**Option 2: Self Install** 
1. Create a folder (in your Download folder, for example) called "ORB". Download the github files to the "ORB" folder. If they download as a .zip, extract it.
2. Open Chrome, navigate to the extensions (chrome://extensions/)
4. In the top right, to enable Developer Mode.
5. In the top left, Click "Load unpacked" then select the "ORB" folder.

# Version Notes
**v1.1**
- Added ability to review Auth Policy triggers directly from the Sys Log for "DENY" events.
- Added "Search by application" search bar to the Auth Policies page.

**v1.0**
- Added "Verify MFA" to the user page to allow for Helpdesk IT admins to validate a caller using MFA prompt.
- Added a Search Bar function to the Workflows app, allowing for search regardless of folder location
- Added Exports from the People Page
- Added Push Groups to export options when viewing an app

**v0.9**
- Added App and Group membership Export functions.
- Included options for both profile attributes & app-specific attributes for each user.

**v0.8**
- Added "View Rule" button when looking at a Group, next to users populated by Rule.
- Improved UI elements for consistency and readability, including redesigined menu when clicking the extension's icon.

**v0.7**
- Added ability to select custom attributes from the "Profile" attribute selection without entering "user.customAttribute" by hand
- Added mapping from imported expressions to this new drop-down for easy edits.

**v0.6**
- Added ability to select attributes to be included in preview .csv export, including custom attributes.
- Fixed bug where adding an additional nested logic argument would delete prior logic or blank out already set values
- Added variable evaluation batch sizes to increase speed of processing and testing simple OEL with few arguments, while not timing out on complex expressions

**v0.5**
- Initial release to Chrome Web Store
- Can parse and import expressions, edit in UI.
- Can preview impact by testing against real users before saving the rule.