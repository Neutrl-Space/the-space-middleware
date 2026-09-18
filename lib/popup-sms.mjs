export function smsConfigured(env = process.env) {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER));
}
export async function sendPopupSms({phone, reservationNumber}, env = process.env, fetcher = fetch) {
  if (!smsConfigured(env)) throw new Error('SMS is not configured');
  const body = new URLSearchParams({
    To: phone,
    Body: `NEUTRL SPACE: Your SoHo pop-up reservation ${reservationNumber} is confirmed. Payment is due at collection. Reply STOP to opt out.`,
    ...(env.TWILIO_MESSAGING_SERVICE_SID ? {MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID} : {From: env.TWILIO_FROM_NUMBER}),
  });
  const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`},
    body,
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || !result.sid || ['failed', 'undelivered', 'canceled'].includes(result.status)) throw new Error('SMS provider rejected message');
  return {id: result.sid};
}
