'use client';

import { useState } from 'react';
import Link from 'next/link';
import FloatingDock from '@/components/ui/FloatingDock';
import { OmniIcon } from '@/components/ui/OmniIcon';

export default function RoomSettingsPage() {
  const [activeTab, setActiveTab] = useState<'roles' | 'permissions' | 'owner'>('roles');
  const [editingRole, setEditingRole] = useState('Member');

  const permissionsList = [
    'Text chat', 'File uploads', 'Media control', 'Queue editing',
    'Notes', 'Whiteboard', 'Polls', 'Voice', 'Video', 
    'Screen sharing', 'AI features'
  ];

  return (
    <div className="omni-internal settings-shell flex h-screen flex-col overflow-hidden font-sans">
      {/* Top Navbar */}
      <header className="room-header shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/home" className="text-gray-400 hover:text-white transition text-xl">←</Link>
          <span className="font-bold text-lg">Room Settings: Late Night Study</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-400"><OmniIcon name="settings" size={15} />
          Role: <span className="text-indigo-400 font-bold">Owner</span>
        </div>
      </header>

      <div className="room-content flex-1 overflow-hidden">
        {/* Left Sidebar (Settings Navigation) */}
        <aside className="settings-sidebar flex flex-col gap-2">
          <button onClick={() => setActiveTab('roles')} className={`w-full text-left px-4 py-3 rounded-xl transition font-medium ${activeTab === 'roles' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}>
            👥 Members & Roles
          </button>
          <button onClick={() => setActiveTab('permissions')} className={`w-full text-left px-4 py-3 rounded-xl transition font-medium ${activeTab === 'permissions' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}>
            🛡️ Granular Permissions
          </button>
          <button onClick={() => setActiveTab('owner')} className={`w-full text-left px-4 py-3 rounded-xl transition font-medium ${activeTab === 'owner' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}>
            👑 Owner Controls
          </button>
        </aside>

        {/* Main Content Area */}
        <main className="settings-main relative flex-1 overflow-y-auto p-8">
          <div className="max-w-4xl mx-auto">
            
            {/* TAB 1: MEMBERS & ROLES */}
            {activeTab === 'roles' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div>
                  <h2 className="text-2xl font-bold mb-1">Members & Roles</h2>
                  <p className="text-gray-400 text-sm">Manage who is in your room and assign their hierarchy level.</p>
                </div>
                
                <div className="glass-panel overflow-hidden p-0">
                  {/* Mock Users */}
                  {[
                    { name: 'John Doe (You)', currentRole: 'Owner', color: 'bg-yellow-500' },
                    { name: 'Sarah Miller', currentRole: 'Admin', color: 'bg-red-500' },
                    { name: 'Alex Chen', currentRole: 'Moderator', color: 'bg-green-500' },
                    { name: 'Rohan Gupta', currentRole: 'Member', color: 'bg-blue-500' },
                    { name: 'Guest_9921', currentRole: 'Guest', color: 'bg-gray-500' },
                  ].map((user, i) => (
                    <div key={i} className="flex items-center justify-between p-4 border-b border-white/10 last:border-0 hover:bg-white/5 transition">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center font-bold text-sm">
                          {user.name[0]}
                        </div>
                        <div>
                          <p className="font-medium">{user.name}</p>
                          <p className="text-xs text-gray-400">Joined 2 hours ago</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-3">
                        {user.currentRole === 'Owner' ? (
                          <span className="px-3 py-1 rounded-full bg-yellow-500/20 text-yellow-500 text-xs font-bold border border-yellow-500/20">Owner</span>
                        ) : (
                          <>
                            <select defaultValue={user.currentRole} className="bg-black/50 border border-white/10 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500 text-white">
                              <option value="Admin">Admin</option>
                              <option value="Moderator">Moderator</option>
                              <option value="Member">Member</option>
                              <option value="Guest">Guest</option>
                            </select>
                            <button className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition" title="Remove User">
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB 2: GRANULAR PERMISSIONS */}
            {activeTab === 'permissions' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div>
                  <h2 className="text-2xl font-bold mb-1">Granular Permissions</h2>
                  <p className="text-gray-400 text-sm">Fine-tune exactly what each role is allowed to do in this room.</p>
                </div>

                {/* Role Selector */}
                <div className="glass-panel flex w-fit gap-2 p-1">
                  {['Admin', 'Moderator', 'Member', 'Guest'].map(role => (
                    <button 
                      key={role}
                      onClick={() => setEditingRole(role)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition ${editingRole === role ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                    >
                      {role}
                    </button>
                  ))}
                </div>

                {/* Toggles Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {permissionsList.map((perm, i) => {
                    const isEnabled = editingRole === 'Admin' || editingRole === 'Moderator' || (editingRole === 'Member' && i % 3 !== 0);
                    return (
                      <label key={i} className="flex items-center justify-between p-4 bg-white/5 rounded-xl border border-white/10 cursor-pointer hover:bg-white/10 transition">
                        <span className="font-medium text-sm">{perm}</span>
                        <div className={`w-10 h-5 rounded-full transition-colors relative ${isEnabled ? 'bg-indigo-600' : 'bg-gray-600'}`}>
                          <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* TAB 3: OWNER CONTROLS */}
            {activeTab === 'owner' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div>
                  <h2 className="text-2xl font-bold mb-1">Owner Controls</h2>
                  <p className="text-gray-400 text-sm">Advanced settings and dangerous actions.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <button className="p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-left transition flex flex-col gap-1">
                    <span className="font-bold text-indigo-400">🔒 Lock Room</span>
                    <span className="text-xs text-gray-400">Prevent any new users from joining, even with a code.</span>
                  </button>
                  <button className="p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-left transition flex flex-col gap-1">
                    <span className="font-bold text-indigo-400">👁️ Hide Room</span>
                    <span className="text-xs text-gray-400">Remove from public search immediately.</span>
                  </button>
                  <button className="p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-left transition flex flex-col gap-1">
                    <span className="font-bold text-purple-400">🔄 Convert to Group</span>
                    <span className="text-xs text-gray-400">Make this a permanent space that never expires.</span>
                  </button>
                  <button className="p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-left transition flex flex-col gap-1">
                    <span className="font-bold text-yellow-500">👑 Transfer Ownership</span>
                    <span className="text-xs text-gray-400">Give up owner rights to another user.</span>
                  </button>
                </div>

                <div className="mt-8 pt-8 border-t border-red-500/20">
                  <h3 className="text-red-500 font-bold mb-4">Danger Zone</h3>
                  <button className="px-6 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/30 rounded-xl font-medium transition">
                    Delete Room Permanently
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      <FloatingDock />
    </div>
  );
}
