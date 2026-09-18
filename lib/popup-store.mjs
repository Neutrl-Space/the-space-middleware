export function createPopupStore(supabase) {
  const check = ({data, error}) => {
    if (error) throw new Error('Reservation storage operation failed');
    return data;
  };
  return {
    async claim(input, fingerprint) {
      const result = await supabase.from('popup_reservation_requests').insert({
        request_id: input.requestId, fingerprint, status: 'processing',
      }).select('fingerprint, response, created_at, reservation_code').single();
      if (!result.error) return {owner: true, record: result.data};
      if (result.error.code !== '23505') throw new Error('Reservation request could not be saved');
      const record = check(await supabase.from('popup_reservation_requests').select('fingerprint, response, created_at, reservation_code').eq('request_id', input.requestId).single());
      return {owner: false, record};
    },
    async updateRequest(id, values) {
      check(await supabase.from('popup_reservation_requests').update({...values, updated_at: new Date().toISOString()}).eq('request_id', id).select('request_id').single());
    },
    async createEvent(values) {
      check(await supabase.from('event_orders').insert(values));
    },
  };
}
