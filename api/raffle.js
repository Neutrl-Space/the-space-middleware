import supabase from '../lib/supabase.js';
import { createRaffleHandler } from '../lib/raffle.js';
import { withRequestMonitoring } from '../lib/monitoring.js';
import { sentryReporter } from '../lib/sentry.js';
export default withRequestMonitoring(createRaffleHandler({ db: supabase }), 'raffle', { reporter: sentryReporter });
