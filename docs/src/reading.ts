export interface FollowReadingFunction {
  (
    links: readonly HTMLAnchorElement[],
    onChange: (current: HTMLAnchorElement | undefined) => void,
  ): void;
}

// Follows the reader down the page: the current link is the last whose heading is above the
// reading line, or at the end of the page the last one, whose heading may never reach the line.
export const followReading: FollowReadingFunction = (links, onChange) => {
  const headings = links.flatMap((link) => {
    const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    return heading ? [{ link, heading }] : [];
  });
  const update = () => {
    const line = innerHeight / 4;
    const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    const current = atEnd
      ? headings.at(-1)
      : headings.findLast(({ heading }) => heading.getBoundingClientRect().top < line);
    for (const { link } of headings) {
      if (link === current?.link) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    onChange(current?.link);
  };
  // One update per frame, however many scroll events arrive in it.
  let scheduled = false;
  addEventListener(
    "scroll",
    () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        update();
      });
    },
    { passive: true },
  );
  update();
};
