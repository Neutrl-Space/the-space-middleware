import supabase from '../../lib/supabase';
import {createCancellationHandler} from '../../lib/popup-cancellation.mjs';

export const config = {api: {bodyParser: false}};
export default createCancellationHandler({supabase});
