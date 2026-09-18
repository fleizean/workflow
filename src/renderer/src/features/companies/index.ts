// The feature's public surface: another feature imports this file and nothing deeper (ARCH-03).
export { default as CompaniesPage } from './CompaniesPage';
export { useCompanies } from './api/useCompanies';
// Work History counts sessions per card and words it the same way; one spelling of "1 session" for both screens.
export { describeSessionCount } from './session-counts';
