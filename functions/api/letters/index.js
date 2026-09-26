import { handleSubmit } from '../../../server/letters-api.js';

export const onRequestPost = ({ request, env }) => handleSubmit(request, env);
