import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/overview').then((m) => m.OverviewPage), title: 'Overview' },
  { path: 'containers', loadComponent: () => import('./pages/containers').then((m) => m.ContainersPage), title: 'Containers' },
  { path: 'containers/:id', loadComponent: () => import('./pages/container-detail').then((m) => m.ContainerDetailPage), title: 'Container' },
  { path: 'network', loadComponent: () => import('./pages/network').then((m) => m.NetworkPage), title: 'Network' },
  { path: 'activity', loadComponent: () => import('./pages/activity').then((m) => m.ActivityPage), title: 'Activity' },
  { path: 'backups', loadComponent: () => import('./pages/backups').then((m) => m.BackupsPage), title: 'Backups' },
  { path: 'nas', loadComponent: () => import('./pages/nas').then((m) => m.NasPage), title: 'NAS' },
  { path: 'databases', loadComponent: () => import('./pages/databases').then((m) => m.DatabasesPage), title: 'Databases' },
  { path: 'databases/db', loadComponent: () => import('./pages/database-detail').then((m) => m.DatabaseDetailPage), title: 'Database' },
  { path: 'system', loadComponent: () => import('./pages/system').then((m) => m.SystemPage), title: 'System' },
  { path: '**', redirectTo: '' },
];
