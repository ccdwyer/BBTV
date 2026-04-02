import { Hono } from "hono";
import {
  getAllChildren,
  getChild,
  getChildSchedules,
  getChildBonusTime,
  getChildAvailableBonusMinutes,
  getChildTimeStatus,
  getChildWatchHistory,
  getMediaItem,
  getDayName,
  type Child,
} from "../lib/db";
import { generateSpecialQrSvg } from "../lib/qrcode";
import { config } from "../lib/config";

const childrenAdmin = new Hono();

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function layout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - BBTV Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; }
    nav { background: #1a1a2e; color: white; padding: 1rem 2rem; display: flex; align-items: center; gap: 2rem; }
    nav a { color: #a0a0c0; text-decoration: none; font-weight: 500; }
    nav a:hover { color: white; }
    nav h1 { color: #e94560; font-size: 1.5rem; margin-right: 1rem; }
    .container { max-width: 1000px; margin: 2rem auto; padding: 0 2rem; }
    .card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 1.5rem; margin-bottom: 1rem; }
    .btn { display: inline-block; padding: 0.5rem 1rem; border-radius: 6px; border: none; cursor: pointer; font-size: 0.9rem; font-weight: 500; text-decoration: none; }
    .btn-primary { background: #e94560; color: white; }
    .btn-primary:hover { background: #d63851; }
    .btn-secondary { background: #eee; color: #333; }
    .btn-secondary:hover { background: #ddd; }
    .btn-sm { padding: 0.3rem 0.75rem; font-size: 0.8rem; }
    .btn-danger { background: #ff4444; color: white; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.6rem; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #666; font-size: 0.85rem; }
    input, select { padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px; font-size: 0.9rem; }
    .child-card { display: flex; align-items: center; gap: 1.5rem; padding: 1rem; }
    .child-avatar { width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; font-weight: 700; color: white; }
    .child-info h3 { margin-bottom: 0.25rem; }
    .child-info .status { font-size: 0.85rem; color: #888; }
    .child-actions { margin-left: auto; display: flex; gap: 0.5rem; }
    .toast { position: fixed; bottom: 2rem; right: 2rem; background: #333; color: white; padding: 1rem 1.5rem; border-radius: 8px; display: none; z-index: 100; }
    .toast.show { display: block; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .section-title { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 0.75rem; }
    .qr-container { text-align: center; padding: 1rem; }
    .qr-container svg { max-width: 150px; }
    .bonus-form { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.75rem; }
  </style>
</head>
<body>
  <nav>
    <h1>BBTV</h1>
    <a href="/admin">Dashboard</a>
    <a href="/admin/library">Library</a>
    <a href="/admin/children">Children</a>
    <a href="/admin/download">Download</a>
    <a href="/admin/print">Print Book</a>
    <a href="/admin/settings">Settings</a>
  </nav>
  <div class="container">${content}</div>
  <div class="toast" id="toast"></div>
  <script>
    function showToast(msg) {
      var t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(function() { t.classList.remove('show'); }, 3000);
    }
  </script>
</body>
</html>`;
}

// --- List children ---

childrenAdmin.get("/", (c) => {
  const children = getAllChildren();

  const childCards = children.map((child) => {
    const status = getChildTimeStatus(child.id);
    const mins = status ? Math.floor(status.remainingSeconds / 60) : 0;
    const watched = status ? Math.round(status.watchedTodaySeconds / 60) : 0;
    const bonus = getChildAvailableBonusMinutes(child.id);

    return `
      <div class="card child-card">
        <div class="child-avatar" style="background: ${escapeHtml(child.avatar_color)};">
          ${escapeHtml(child.name.charAt(0).toUpperCase())}
        </div>
        <div class="child-info">
          <h3>${escapeHtml(child.name)}</h3>
          <div class="status">
            Today: ${watched} min watched, ${mins} min remaining
            ${bonus > 0 ? ` | ${bonus} bonus min available` : ""}
          </div>
        </div>
        <div class="child-actions">
          <a href="/admin/children/${encodeURIComponent(child.id)}" class="btn btn-secondary btn-sm">Manage</a>
        </div>
      </div>
    `;
  }).join("");

  return c.html(layout("Children", `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
      <h2>Children</h2>
      <button class="btn btn-primary" onclick="document.getElementById('add-form').style.display='block'">Add Child</button>
    </div>

    <div class="card" id="add-form" style="display: none; margin-bottom: 1.5rem;">
      <h3 style="margin-bottom: 1rem;">Add Child</h3>
      <div class="grid-2">
        <div>
          <label style="display: block; font-weight: 600; margin-bottom: 0.25rem;">Name</label>
          <input type="text" id="new-name" placeholder="Child's name" style="width: 100%;" />
        </div>
        <div>
          <label style="display: block; font-weight: 600; margin-bottom: 0.25rem;">Color</label>
          <input type="color" id="new-color" value="#e94560" style="width: 60px; height: 38px; padding: 2px;" />
        </div>
      </div>
      <h4 style="margin: 1rem 0 0.5rem;">Weekday Schedule (Mon-Fri)</h4>
      <div class="grid-2">
        <div>
          <label>Daily allotment (min)</label>
          <input type="number" id="new-wd-allot" value="30" min="0" max="480" style="width: 80px;" />
        </div>
        <div>
          <label>Daily maximum (min)</label>
          <input type="number" id="new-wd-max" value="60" min="0" max="480" style="width: 80px;" />
        </div>
      </div>
      <h4 style="margin: 1rem 0 0.5rem;">Weekend Schedule (Sat-Sun)</h4>
      <div class="grid-2">
        <div>
          <label>Daily allotment (min)</label>
          <input type="number" id="new-we-allot" value="60" min="0" max="480" style="width: 80px;" />
        </div>
        <div>
          <label>Daily maximum (min)</label>
          <input type="number" id="new-we-max" value="120" min="0" max="480" style="width: 80px;" />
        </div>
      </div>
      <div style="margin-top: 1rem;">
        <button class="btn btn-primary" onclick="addChild()">Create</button>
        <button class="btn btn-secondary" onclick="document.getElementById('add-form').style.display='none'" style="margin-left: 0.5rem;">Cancel</button>
      </div>
    </div>

    ${childCards || '<p style="color: #888;">No children configured. Add a child to enable per-child time tracking.</p>'}

    <script>
      async function addChild() {
        var name = document.getElementById('new-name').value.trim();
        if (!name) return showToast('Enter a name');
        var res = await fetch('/api/children', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name,
            avatarColor: document.getElementById('new-color').value,
            weekdayAllotment: parseInt(document.getElementById('new-wd-allot').value) || 30,
            weekdayMax: parseInt(document.getElementById('new-wd-max').value) || 60,
            weekendAllotment: parseInt(document.getElementById('new-we-allot').value) || 60,
            weekendMax: parseInt(document.getElementById('new-we-max').value) || 120,
          })
        });
        if (res.ok) {
          showToast('Child added!');
          setTimeout(function() { location.reload(); }, 500);
        }
      }
    </script>
  `));
});

// --- Child detail ---

childrenAdmin.get("/:id", async (c) => {
  const child = getChild(c.req.param("id"));
  if (!child) return c.html(layout("Not Found", "<p>Child not found</p>"), 404);

  const status = getChildTimeStatus(child.id);
  const schedules = getChildSchedules(child.id);
  const bonusList = getChildBonusTime(child.id);
  const availableBonus = getChildAvailableBonusMinutes(child.id);
  const history = getChildWatchHistory(child.id, 20);
  const qrSvg = await generateSpecialQrSvg(child.qr_code_id);

  // Build schedule table (fill in missing days with defaults)
  const scheduleMap = new Map(schedules.map((s) => [s.day_of_week, s]));
  const scheduleRows = Array.from({ length: 7 }, (_, day) => {
    const s = scheduleMap.get(day);
    return `<tr>
      <td>${escapeHtml(getDayName(day))}${day === 0 || day === 6 ? " (weekend)" : ""}</td>
      <td><input type="number" class="sched-allot" data-day="${day}" value="${s?.allotment_minutes ?? 30}" min="0" max="480" style="width:70px;" /></td>
      <td><input type="number" class="sched-max" data-day="${day}" value="${s?.max_minutes ?? 60}" min="0" max="480" style="width:70px;" /></td>
    </tr>`;
  }).join("");

  const bonusRows = bonusList.slice(0, 10).map((b) => `
    <tr>
      <td>${escapeHtml(b.reason)}</td>
      <td>${b.minutes} min</td>
      <td>${b.spent_minutes} min</td>
      <td>${b.minutes - b.spent_minutes} min</td>
      <td>${escapeHtml(b.granted_at.slice(0, 10))}</td>
    </tr>
  `).join("");

  const historyRows = history.map((h) => {
    const media = h.media_id ? getMediaItem(h.media_id) : null;
    return `<tr>
      <td>${escapeHtml(h.date)}</td>
      <td>${media ? escapeHtml(media.title) : "Unknown"}</td>
      <td>${Math.round(h.duration_seconds / 60)} min</td>
    </tr>`;
  }).join("");

  const watchedMins = status ? Math.round(status.watchedTodaySeconds / 60) : 0;
  const remainingMins = status ? Math.floor(status.remainingSeconds / 60) : 0;

  return c.html(layout(child.name, `
    <div style="display: flex; gap: 2rem; margin-bottom: 2rem;">
      <div>
        <div class="child-avatar" style="background: ${escapeHtml(child.avatar_color)}; width: 100px; height: 100px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2.5rem; font-weight: 700; color: white;">
          ${escapeHtml(child.name.charAt(0).toUpperCase())}
        </div>
        <div class="qr-container" style="margin-top: 1rem;">
          ${qrSvg}
          <div style="font-size: 0.7rem; color: #888; margin-top: 0.25rem;">Sign-in QR code</div>
        </div>
      </div>
      <div style="flex: 1;">
        <h2>${escapeHtml(child.name)}</h2>
        <p style="color: #888; margin: 0.5rem 0;">
          Today: <strong>${watchedMins} min</strong> watched, <strong>${remainingMins} min</strong> remaining
          ${availableBonus > 0 ? ` | <strong>${availableBonus} bonus min</strong> available` : ""}
        </p>
        <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
          <button class="btn btn-danger btn-sm" onclick="if(confirm('Delete ${escapeHtml(child.name)}?')) deleteChild('${escapeHtml(child.id)}')">Delete Child</button>
        </div>
      </div>
    </div>

    <h3 class="section-title">Grant Bonus Time</h3>
    <div class="card">
      <p style="color: #666; margin-bottom: 0.75rem;">
        Reward extra screen time for chores or good behavior. Bonus time is available on any day, up to the daily maximum.
      </p>
      <div class="bonus-form">
        <input type="number" id="bonus-minutes" value="15" min="1" max="120" style="width: 70px;" />
        <span>minutes for</span>
        <input type="text" id="bonus-reason" placeholder="e.g., cleaned room, did homework" style="flex: 1;" />
        <button class="btn btn-primary btn-sm" onclick="grantBonus()">Grant</button>
      </div>
    </div>

    <h3 class="section-title">Weekly Schedule</h3>
    <div class="card">
      <p style="color: #666; margin-bottom: 0.75rem;">
        <strong>Allotment</strong> = free daily minutes. <strong>Maximum</strong> = cap including bonus time.
      </p>
      <table>
        <thead><tr><th>Day</th><th>Allotment</th><th>Maximum</th></tr></thead>
        <tbody>${scheduleRows}</tbody>
      </table>
      <div style="margin-top: 1rem;">
        <button class="btn btn-primary btn-sm" onclick="saveSchedule()">Save Schedule</button>
      </div>
    </div>

    ${bonusList.length > 0 ? `
      <h3 class="section-title">Bonus Time History</h3>
      <div class="card">
        <table>
          <thead><tr><th>Reason</th><th>Granted</th><th>Spent</th><th>Remaining</th><th>Date</th></tr></thead>
          <tbody>${bonusRows}</tbody>
        </table>
      </div>
    ` : ""}

    ${history.length > 0 ? `
      <h3 class="section-title">Recent Watch History</h3>
      <div class="card">
        <table>
          <thead><tr><th>Date</th><th>Title</th><th>Duration</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>
    ` : ""}

    <script>
      async function grantBonus() {
        var minutes = parseInt(document.getElementById('bonus-minutes').value) || 0;
        var reason = document.getElementById('bonus-reason').value.trim();
        if (!minutes || !reason) return showToast('Enter minutes and a reason');
        await fetch('/api/children/${escapeHtml(child.id)}/bonus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minutes: minutes, reason: reason })
        });
        showToast(minutes + ' bonus minutes granted!');
        setTimeout(function() { location.reload(); }, 500);
      }

      async function saveSchedule() {
        var allots = document.querySelectorAll('.sched-allot');
        var maxes = document.querySelectorAll('.sched-max');
        for (var i = 0; i < 7; i++) {
          await fetch('/api/children/${escapeHtml(child.id)}/schedule/' + i, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              allotmentMinutes: parseInt(allots[i].value) || 0,
              maxMinutes: parseInt(maxes[i].value) || 0,
            })
          });
        }
        showToast('Schedule saved!');
      }

      async function deleteChild(id) {
        await fetch('/api/children/' + encodeURIComponent(id), { method: 'DELETE' });
        window.location.href = '/admin/children';
      }
    </script>
  `));
});

export { childrenAdmin };
