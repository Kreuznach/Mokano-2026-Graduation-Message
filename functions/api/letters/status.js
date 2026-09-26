import { handleStatus } from '../../../server/letters-api.js';

export const onRequestGet = ({ request, env }) => handleStatus(request, env);
