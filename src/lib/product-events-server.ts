import 'server-only';

import { cookies } from 'next/headers';
import { after } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cleanRef, productEventArgs, REF_COOKIE, type ProductEvent, type ProductEventOptions } from '@/lib/product-events';

type ServerClient = Awaited<ReturnType<typeof createClient>>;

// Server helper for server actions and route handlers: the RPC runs after the
// response (next/server `after`) and never throws, so a metric can't slow down
// or break the action. `shouldLog` (optional) runs first, inside `after`, for
// checks such as "is this a new membership".
export function logProductEventAfter(
  event: ProductEvent,
  options: ProductEventOptions = {},
  shouldLog?: (supabase: ServerClient) => Promise<boolean>,
) {
  try {
    after(async () => {
      try {
        const cookieRef = cleanRef((await cookies()).get(REF_COOKIE)?.value);
        const supabase = await createClient();
        if (shouldLog && !(await shouldLog(supabase))) return;
        await supabase.rpc('log_product_event', productEventArgs(event, options, cookieRef));
      } catch {
        // Metrics are best effort.
      }
    });
  } catch {
    // `after` outside a request scope: skip the metric.
  }
}
