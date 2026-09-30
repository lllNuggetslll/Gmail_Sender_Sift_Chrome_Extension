# Gmail Sender Sift

A small Chrome extension for cleaning out a large Gmail inbox. It adds a floating panel inside Gmail that scans your mail, groups it by sender, and lets you archive or trash whole senders at once.

Built as a personal tool. It talks directly from your browser to the Gmail API using your own OAuth client. There is no backend server, no analytics, and no third party ever sees your mail.

## Features

- **Group by sender**, sorted by message count or A to Z, with unread counts per sender
- **Quick filters** for Inbox, Promotions, Updates, Social, Forums, Unread, and All mail, plus a free-text box that accepts any [Gmail search operator](https://support.google.com/mail/answer/7190)
- **Year filter** that narrows any scan to a single calendar year
- **Batch archive or trash**, at sender level or per message
- **Shift-click range select** on both sender and message checkboxes
- **Stop button** that cancels a running scan and keeps the partial results
- **Sign-in status** in the panel header (signed in with time left, or signed out), with Sign in / Sign out buttons. Sign out also revokes the token with Google
- **Undo toast** for 15 seconds after any archive or trash
- **Unsubscribe link** shown for senders that send a `List-Unsubscribe` header

Trash uses Gmail's normal trash, so everything stays recoverable for 30 days. Nothing is permanently deleted.

## How it works

| Piece | Role |
| --- | --- |
| `content.js` + `style.css` | The panel UI, injected into `mail.google.com` |
| `background.js` (service worker) | OAuth, token caching, and all Gmail API calls (`messages.list`, `messages.get`, `messages.batchModify`) |
| `manifest.json` | Manifest V3, with permissions limited to `identity`, `storage`, and the two Gmail hosts |

Auth uses `chrome.identity.launchWebAuthFlow` against a standard **Web application** OAuth client. The access token is cached in `chrome.storage.session` (cleared when the browser closes) and reused until it expires, so page reloads don't force a new login. The token's expiry time is known up front, so the panel flips to a signed-out state when it runs out (or the moment the API returns a 401) instead of failing on your next click. There is no refresh token in this flow, so expiry (about an hour) means signing in again.

Scans read message metadata only (From, Subject, Date, List-Unsubscribe), never bodies. The default scan cap is 3,000 messages.

## Setup

You need to create your own Google Cloud OAuth client, because the extension is not published and Google's verification for the Gmail scope it uses only applies to public apps. This takes about ten minutes.

### 1. Load the extension

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Copy the extension's **ID** (32 letters) from its card. Keep the folder where it is: with unpacked extensions, moving the folder changes the ID.

### 2. Find your redirect URI

Your redirect URI is `https://<extension-id>.chromiumapp.org/`, using the ID from step 1, with the trailing slash.

To double-check it: on the extension's card click **service worker**, and in the console that opens run:

```js
chrome.identity.getRedirectURL()
```

### 3. Create the OAuth client

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library**: search for **Gmail API** and click **Enable**.
3. **APIs & Services → OAuth consent screen** (or **Google Auth Platform**):
   - User type: **External**
   - Fill in an app name and your email for support and contact
   - Add the scope `https://www.googleapis.com/auth/gmail.modify`
   - Under **Test users**, add your own Gmail address
   - Leave publishing status as **Testing**
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Under **Authorized redirect URIs**, add the URI from step 2
   - Create it and copy the **Client ID**. You do not need the client secret.

### 4. Add your client ID

In `background.js`, replace the placeholder:

```js
const OAUTH_CLIENT_ID = 'REPLACE_WITH_YOUR_WEB_APP_CLIENT_ID.apps.googleusercontent.com';
```

Then click the reload icon on the extension's card in `chrome://extensions`. The client ID is not a secret, but avoid committing your own to a public fork.

## Usage

1. Open Gmail and click the round envelope button at the bottom right.
2. Pick a quick filter (or type a query), optionally choose a year, and click **Scan**.
3. The first time, Google shows an "unverified app" warning. That is expected in Testing mode. Click **Advanced**, then **Go to (your app name)**, and approve the scope.
4. Tick senders to select every message from them, or expand a sender to pick individual messages. Shift-click to select a range.
5. Click **Archive** or **Trash**. The page reloads afterward so Gmail's own view refreshes, and the panel restores its state.

## Known limitations

- **Testing mode only.** Only the test users you list can sign in, and Google expires the consent for Testing-mode apps periodically, so you will occasionally be asked to approve again.
- **Scan cap of 3,000 messages** per scan (`MAX_MESSAGES_DEFAULT` in `background.js`, and `maxMessages` in `content.js`). Run repeated scans, or narrow by year, to work through a large mailbox.
- **Page reload after each action.** Gmail's UI caches its lists client-side and does not notice label changes made through the API until it refetches.
- **Unsubscribe links** only appear when the sender provides a `List-Unsubscribe` header.
- **Not on the Chrome Web Store.** Publishing publicly would require Google's OAuth verification for a restricted Gmail scope, which is out of scope for this project.

## Troubleshooting

| Error | Cause |
| --- | --- |
| `Error 401: invalid_client` / "OAuth client was not found" | `OAUTH_CLIENT_ID` is still the placeholder, has a typo or stray whitespace, or belongs to a deleted or different project. Reload the extension after editing. |
| `Error 400: redirect_uri_mismatch` | The redirect URI on the OAuth client doesn't exactly match `chrome.identity.getRedirectURL()`. Check for the trailing slash and that the extension ID hasn't changed. |
| `Error 403: access_denied` | Your Google account isn't listed under **Test users**. |
| `Gmail API 401` | The token expired or was revoked. The cache clears itself, so just scan again. |
| `Gmail API 403` (API not enabled) | Enable the Gmail API in the same project as your OAuth client. |

### Why not `chrome.identity.getAuthToken`?

The obvious approach is `getAuthToken` with a "Chrome Extension" OAuth client, and this project tried it first. For an unpacked extension it failed with `bad client id` even with the extension ID and client configuration verified as matching. Per [Chrome's OAuth docs](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth), that flow expects a stable extension ID tied to a Chrome Web Store developer-dashboard listing and a `key` in the manifest. `launchWebAuthFlow` with a Web application client has no such requirement, so that is what this uses.

## Privacy and security

- All requests go from your browser to `gmail.googleapis.com`. There is no server component.
- The only scope requested is `gmail.modify`, which lets the extension read and change labels on your mail. It cannot send mail or permanently delete anything.
- The token lives in `chrome.storage.session` and is discarded when the browser closes.
- Review the source before running it against a mailbox you care about. It is small enough to read in one sitting.

## License

MIT. See [LICENSE](LICENSE).
