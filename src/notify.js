const settings = require('./settings');
const { KIND_LABELS } = require('./scheduler');

async function postWeeklySchedule(weekStart, slots) {
  const webhookUrl = await settings.get('slack_webhook_url');
  if (!webhookUrl) return { sent: false, reason: 'No Slack webhook URL configured in Settings' };

  const byDate = {};
  for (const s of slots) {
    if (!byDate[s.slot_date]) byDate[s.slot_date] = [];
    byDate[s.slot_date].push(s);
  }
  const dates = Object.keys(byDate).sort();
  const lines = [`*Weekly schedule — week of ${weekStart}*`];
  for (const date of dates) {
    lines.push(`\n*${date}*`);
    for (const s of byDate[date].sort((a, b) => a.kind.localeCompare(b.kind))) {
      const who = s.assignee_name || '_unfilled_';
      lines.push(`• ${s.project_name} — ${KIND_LABELS[s.kind]}: ${who}`);
    }
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { sent: false, reason: `Slack responded with ${res.status}: ${body}` };
  }
  return { sent: true };
}

module.exports = { postWeeklySchedule };
