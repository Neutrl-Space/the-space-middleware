// shared Klaviyo helper
async function triggerKlaviyoEvent(eventName, email, properties = {}) {
  const response = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      revision: '2024-02-15'
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: eventName } } },
          profile: { data: { type: 'profile', attributes: { email } } },
          properties
        }
      }
    })
  });

  if (!response.ok) {
    console.error('Klaviyo error:', await response.text());
  }
}

module.exports = { triggerKlaviyoEvent };
