import { registerPremiumResearchSurface } from './server';

const registration = registerPremiumResearchSurface({
  providerId: process.env.OPENRAILS_PROVIDER_ID || 'research.provider.or',
  registerEndpoint: process.env.OPENRAILS_REGISTER_ENDPOINT || 'https://agent.example/api/provider/register',
});

console.log(JSON.stringify(registration, null, 2));
