// PC Status widget (Scriptable)
// Displays matts-pc's cached power state, read from the Pi's /pc-status
// endpoint. No live SSH/ping check happens here - the Pi does that in the
// background, this just reads the cache so it stays fast and well within
// the widget's execution budget.
//
// Setup: paste this into a new Scriptable script named e.g. "PC Status",
// then add a Scriptable widget to your home screen and pick this script.
// First run (in-app, not as a widget) will prompt for the token from
// token.txt on the Pi and store it in Keychain.

const BASE_URL = "https://YOUR-TAILNET-HOSTNAME.ts.net"; // your Pi's tailnet address, from `tailscale serve status`
const KEYCHAIN_KEY = "pc-remote-token";
const REFRESH_HINT_MINUTES = 10;

const STYLES = {
  "ready": { color: "#34c759", label: "On" },
  "powered-off": { color: "#8e8e93", label: "Off" },
  "booting-up": { color: "#ff9f0a", label: "Booting up" },
  "shutting-down": { color: "#ff9f0a", label: "Shutting down" },
  "unknown": { color: "#8e8e93", label: "Unknown" },
};

async function getToken() {
  if (Keychain.contains(KEYCHAIN_KEY)) {
    return Keychain.get(KEYCHAIN_KEY);
  }
  if (config.runsInWidget) {
    return null; // can't prompt from a widget context
  }
  const alert = new Alert();
  alert.title = "PC Remote Token";
  alert.message = "Paste the token from token.txt on the Pi. Stored in Keychain, only asked once.";
  alert.addTextField("token");
  alert.addAction("Save");
  await alert.present();
  const token = alert.textFieldValue(0);
  if (token) {
    Keychain.set(KEYCHAIN_KEY, token);
  }
  return token || null;
}

async function fetchStatus(token) {
  const req = new Request(`${BASE_URL}/pc-status?token=${encodeURIComponent(token)}`);
  req.timeoutInterval = 8;
  const body = await req.loadString();
  const statusCode = req.response.statusCode;
  if (statusCode === 403) {
    throw new Error("bad token");
  }
  if (statusCode !== 200) {
    throw new Error(`http ${statusCode}`);
  }
  return JSON.parse(body);
}

function buildWidget(status, fetchError) {
  const widget = new ListWidget();
  widget.backgroundColor = Color.dynamic(Color.white(), Color.black());
  widget.setPadding(16, 16, 16, 16);

  const style = STYLES[status?.state] ?? STYLES.unknown;

  const nameText = widget.addText("MATTS-PC");
  nameText.font = Font.mediumSystemFont(11);
  nameText.textColor = Color.gray();

  widget.addSpacer();

  const stateStack = widget.addStack();
  stateStack.centerAlignContent();
  const dot = SFSymbol.named("circle.fill");
  dot.applyFont(Font.systemFont(10));
  const dotEl = stateStack.addImage(dot.image);
  dotEl.imageSize = new Size(10, 10);
  dotEl.tintColor = new Color(style.color);
  stateStack.addSpacer(6);
  const stateText = stateStack.addText(style.label);
  stateText.font = Font.boldSystemFont(19);
  stateText.textColor = new Color(style.color);

  widget.addSpacer();

  if (fetchError) {
    const message = fetchError === "bad token" ? "wrong token saved" : `can't reach Pi (${fetchError})`;
    const errText = widget.addText(message);
    errText.font = Font.systemFont(10);
    errText.textColor = Color.red();
    errText.lineLimit = 2;
    errText.minimumScaleFactor = 0.7;
  } else if (status?.error) {
    const errText = widget.addText(status.error);
    errText.font = Font.systemFont(10);
    errText.textColor = Color.red();
    errText.lineLimit = 2;
    errText.minimumScaleFactor = 0.7;
  } else if (status?.checkedAt) {
    const checkedStack = widget.addStack();
    checkedStack.centerAlignContent();
    const label = checkedStack.addText("checked ");
    label.font = Font.systemFont(10);
    label.textColor = Color.gray();
    const dateEl = checkedStack.addDate(new Date(status.checkedAt));
    dateEl.applyRelativeStyle();
    dateEl.font = Font.systemFont(10);
    dateEl.textColor = Color.gray();
  }

  widget.refreshAfterDate = new Date(Date.now() + REFRESH_HINT_MINUTES * 60 * 1000);
  return widget;
}

async function run() {
  let token = await getToken();
  let status = null;
  let fetchError = null;

  if (!token) {
    fetchError = "no token saved";
  } else {
    try {
      status = await fetchStatus(token);
    } catch (e) {
      fetchError = e.message || "unreachable";
    }
  }

  // If the saved token was wrong, offer to re-enter it right away instead of
  // leaving a bad value stuck in Keychain (only possible when run manually -
  // a widget refresh can't show an alert).
  if (fetchError === "bad token" && !config.runsInWidget) {
    Keychain.remove(KEYCHAIN_KEY);
    token = await getToken();
    if (token) {
      try {
        status = await fetchStatus(token);
        fetchError = null;
      } catch (e) {
        fetchError = e.message || "unreachable";
      }
    }
  }

  const widget = buildWidget(status, fetchError);

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentSmall();
  }
  Script.complete();
}

await run();
