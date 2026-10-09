import { pushEndpointProblem, pushPayload } from './push.service.js';

describe('pushEndpointProblem', () => {
  it.each(['https://10.0.0.5:8443/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/x', 'https://[::1]/x', 'http://fcm.googleapis.com/x'])(
    'rejects %s',
    async (endpoint) => {
      expect(await pushEndpointProblem(endpoint), endpoint).not.toBeNull();
    },
  );

  it('accepts a public https push service address', async () => {
    expect(await pushEndpointProblem('https://8.8.8.8/push/abc')).toBeNull();
  });
});

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
