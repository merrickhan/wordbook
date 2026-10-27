// Vercel Function entry point; vercel.json rewrites every /api/* path here.
import { createHandler } from '../server/handler.js';

const handle = createHandler(process.env);

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
