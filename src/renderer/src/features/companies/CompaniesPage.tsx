// The Phase 7 shell of the Companies screen: the real data path, a placeholder presentation. COMP-01..05 build the
// screen itself in Phase 8.

import type { ReactElement } from 'react';
import { useCompanies } from './api/useCompanies';

export default function CompaniesPage(): ReactElement {
    const companies = useCompanies();

    return (
        <section className="px-6 pt-4 pb-28">
            <h1 className="text-2xl font-bold tracking-tight">Companies</h1>
            {companies.isPending ? <p className="mt-4 text-sm text-gray-400">Loading...</p> : null}
            {companies.isError ? <p className="mt-4 text-sm text-red-400">{companies.error.message}</p> : null}
            <ul className="mt-4 space-y-2">
                {(companies.data ?? []).map((company) => (
                    <li key={company.id} className="rounded-xl bg-card-light dark:bg-card-dark px-4 py-3 text-sm">
                        {company.name}
                    </li>
                ))}
            </ul>
        </section>
    );
}
