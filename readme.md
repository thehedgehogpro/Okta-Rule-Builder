# ORB (Okta Rule Builder) adds new user-friendly features to Group Rules via a Chrome plugin
1. Edit Okta Expression Language in a visual logic-builder UI
2. Run real-time tests against your expression and see which users match your expression.
...and more coming soon.

# Install the extension
1. Create a folder on your hard drive called "ORB". Download the files to the "ORB" folder.
2. Open Chrome, navigate to the extensions (chrome://extensions/)
4. Click to enable Developer Mode in the top right.
5. Click "Load unpacked" in the top left, then select the "ORB" folder.

# Version Notes

**v0.7**
*Added ability to select custom attributes directly from the "Profile" attribute selection withou having to manually type "user.customAttribute"
*Added mapping from imported expressions to this new drop-down for easy edits.

**v0.6**
-Added ability to select attributes to be included in preview .csv export, including custom attributes.
-Fixed bug where adding an additional nested logic argument would delete prior logic or blank out already set values
-Added variable evaluation batch sizes to increase speed of processing and testing simple OEL with few arguments, while not timing out on complex expressions

**v0.5**
-Initial release to Chrome Web Store
-Can parse and import expressions, edit in UI.
-Can preview impact by testing against real users before saving the rule.
