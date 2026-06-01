import dotenv from 'dotenv';
dotenv.config();
import { refreshToken } from './lib/token-refresh.js';

console.log('Starting manual token refresh test...');
refreshToken('minababy17012004_gmail_com')
    .then(token => console.log('Refresh result token:', token))
    .catch(err => console.error('Refresh error:', err));
