/**
 * Every 5 minutes: has a time opened up on any day someone is waiting for?
 *
 * Looking at the calendar itself, rather than listening for cancellations,
 * catches every way a time can free up: a client cancelling or moving online,
 * Sandy cancelling in the Square app, deleting a blocked-off hour, opening a
 * Wednesday, or a far-off day coming into the booking window. It also takes
 * anyone who has since booked that day off its list. With nobody waiting it
 * reads one empty list and stops. Scheduled functions only run on the live
 * site, so this always works on the real list.
 */
import { getStore } from '@netlify/blobs';
import { availability, phonesBooked } from './square.mjs';
import { sweep } from '../shared/waitlist.mjs';
import { mailer } from './waitlist.mjs';

export default async () => {
  try {
    const report = await sweep({
      store: getStore({ name: 'waitlist', consistency: 'strong' }),
      availability,
      phonesBooked,
      mail: mailer(),
    });
    if (report.notified.length || report.cleared || report.booked) console.log('waitlist sweep:', JSON.stringify(report));
  } catch (err) {
    console.error('waitlist sweep failed:', err.message);
  }
  return new Response('OK');
};

export const config = { schedule: '*/5 * * * *' };
