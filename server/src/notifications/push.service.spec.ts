import { pushPayload } from './push.service.js';

describe('pushPayload', () => {
  it('uses the shape Angular\'s service worker shows and opens the page on click', () => {
    const { notification } = JSON.parse(pushPayload({ title: 'Ana assigned you BUG-1', body: 'Login fails', path: '/acme/issues/BUG-1', tag: 'assigned:in_1' }));
    expect(notification).toMatchObject({
      title: 'Ana assigned you BUG-1',
      body: 'Login fails',
      tag: 'assigned:in_1',
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/acme/issues/BUG-1' } } },
    });
  });

  it('leaves out the body and tag when there are none', () => {
    const { notification } = JSON.parse(pushPayload({ title: 'Hello', path: '/acme' }));
    expect(notification).not.toHaveProperty('body');
    expect(notification).not.toHaveProperty('tag');
  });
});
