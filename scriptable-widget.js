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
  "ready": { color: "#34c759", label: "On", symbol: "power" },
  "powered-off": { color: "#8e8e93", label: "Off", symbol: "power" },
  "booting-up": { color: "#ff9f0a", label: "Booting up", symbol: "arrow.triangle.2.circlepath" },
  "shutting-down": { color: "#ff9f0a", label: "Shutting down", symbol: "arrow.triangle.2.circlepath" },
  "unknown": { color: "#8e8e93", label: "Unknown", symbol: "questionmark.circle" },
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
  return await req.loadJSON();
}

function buildWidget(status, fetchError) {
  const widget = new ListWidget();
  widget.backgroundColor = Color.dynamic(Color.white(), Color.black());

  const style = STYLES[status?.state] ?? STYLES.unknown;

  const header = widget.addStack();
  header.centerAlignContent();
  const icon = SFSymbol.named(style.symbol);
  icon.applyFont(Font.systemFont(14));
  const iconEl = header.addImage(icon.image);
  iconEl.imageSize = new Size(14, 14);
  iconEl.tintColor = new Color(style.color);
  header.addSpacer(6);
  const nameText = header.addText("matts-pc");
  nameText.font = Font.mediumSystemFont(12);
  nameText.textColor = Color.gray();

  widget.addSpacer(8);

  const stateText = widget.addText(style.label);
  stateText.font = Font.boldSystemFont(20);
  stateText.textColor = new Color(style.color);

  widget.addSpacer(4);

  if (fetchError) {
    const errText = widget.addText(`can't reach Pi (${fetchError})`);
    errText.font = Font.systemFont(10);
    errText.textColor = Color.red();
    errText.lineLimit = 2;
  } else if (status?.error) {
    const errText = widget.addText(status.error);
    errText.font = Font.systemFont(10);
    errText.textColor = Color.red();
    errText.lineLimit = 2;
  } else if (status?.checkedAt) {
    const ageSeconds = Math.round((Date.now() - status.checkedAt) / 1000);
    const ageText = widget.addText(`checked ${ageSeconds}s ago`);
    ageText.font = Font.systemFont(10);
    ageText.textColor = Color.gray();
  }

  widget.refreshAfterDate = new Date(Date.now() + REFRESH_HINT_MINUTES * 60 * 1000);
  return widget;
}

async function run() {
  const token = await getToken();
  let status = null;
  let fetchError = null;

  if (!token) {
    fetchError = "no token saved";
  } else {
    try {
      status = await fetchStatus(token);
    } catch (e) {
      fetchError = "unreachable";
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
