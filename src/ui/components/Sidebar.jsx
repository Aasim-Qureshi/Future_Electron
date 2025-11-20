import React from 'react';

const Sidebar = ({ currentView, onViewChange }) => {
    const menuItems = [
        { id: 'login', label: 'Authentication', icon: '🔐' },
        { id: 'check-status', label: 'Check Browser', icon: '📊' },
        { id: 'validate-report', label: 'Validate Report', icon: '🔍' },
    ];

    return (
        <div className="w-64 bg-gray-900 text-white h-screen flex flex-col">
            {/* Logo/Header */}
            <div className="p-6 border-b border-gray-700">
                <h1 className="text-xl font-bold text-white">🤖 AutoBot</h1>
                <p className="text-gray-400 text-sm mt-1">Automation Suite</p>
            </div>

            {/* Navigation Menu */}
            <nav className="flex-1 p-4">
                <ul className="space-y-2">
                    {menuItems.map((item) => (
                        <li key={item.id}>
                            <button
                                onClick={() => onViewChange(item.id)}
                                className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200 ${currentView === item.id
                                    ? 'bg-blue-600 text-white shadow-lg'
                                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                                    }`}
                            >
                                <span className="text-lg">{item.icon}</span>
                                <span className="font-medium">{item.label}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            </nav>

            {/* Footer/Status */}
            <div className="p-4 border-t border-gray-700">
                <div className="flex items-center space-x-2 text-sm text-gray-400">
                    <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                    <span>System Online</span>
                </div>
            </div>
        </div>
    );
};

export default Sidebar;