export async function waitForFriendPageReady({
  targetPage,
  getPager,
  getItems,
  sleep,
  maxAttempts = 10,
  intervalMs = 500
}) {
  let lastPager = { currentPage: 1, totalPages: 1, totalItems: null };
  let lastItems = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastPager = await getPager();
    lastItems = await getItems();

    if (lastPager.currentPage === targetPage && lastItems.length > 0) {
      return {
        ready: true,
        pager: lastPager,
        items: lastItems,
        attempts: attempt
      };
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  return {
    ready: false,
    pager: lastPager,
    items: lastItems,
    attempts: maxAttempts
  };
}