const handlers = {
  index: () => import('./project-handlers/index.js'),
  approve: () => import('./project-handlers/approve.js'),
  reject: () => import('./project-handlers/reject.js'),
  'status-changed': () => import('./project-handlers/status-changed.js'),
  'email-preview': () => import('./project-handlers/email-preview.js'),
};

export function createProjectRouter(loaders = handlers) {
  return async (req, res) => {
    // Vercel supplies this private routing parameter; approval IDs/tokens and bodies pass through intact.
    const action = req.query?.__projectAction;
    if (typeof action !== 'string' || !Object.hasOwn(loaders, action)) {
      return res.status(404).json({ error: 'Project endpoint not found.' });
    }
    const { default: handler } = await loaders[action]();
    return handler(req, res);
  };
}
