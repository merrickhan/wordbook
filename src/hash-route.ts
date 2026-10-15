export type PageRoute = 'words' | 'add';

export function routeHash(route: PageRoute): string {
  return `#/${route}`;
}

export function readRoute(hash: string): PageRoute {
  return hash === '#/add' ? 'add' : 'words';
}

export function routeUrl(pageUrl: string, route: PageRoute): string {
  const url = new URL(pageUrl);
  url.hash = routeHash(route);
  return url.href;
}

export function isPlainNavigation(
  event: Pick<MouseEvent, 'defaultPrevented' | 'button' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  link: Pick<HTMLAnchorElement, 'target' | 'hasAttribute'>,
): boolean {
  return !event.defaultPrevented
    && event.button === 0
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && (link.target === '' || link.target.toLowerCase() === '_self')
    && !link.hasAttribute('download');
}
