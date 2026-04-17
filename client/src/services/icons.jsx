/**
 * Centralized icon mapping — replaces all emoji icons with Lucide React SVGs.
 * Usage: import { Icon } from '../services/icons.jsx';
 *        <Icon name="workflow" size={18} />
 */
import {
    FileText, Key, Settings, LogOut, LayoutDashboard,
    Copy, Trash2, Plus, Save, Play, ChevronDown, ChevronUp, X,
    Users, CheckCircle2, Zap, Clapperboard, CircleCheck, TrendingUp,
    BarChart3, Clock, UserPlus, Search, Pencil, Ban, ShieldCheck,
    Upload, Shuffle, Palette, MessageSquare, Download, FileEdit,
    Timer, Scissors, Brain, Wrench, FolderOpen, Package, Camera,
    ArrowLeft, Paperclip, RefreshCw, FileUp, Link, Send,
    Mail, MailCheck, AlertTriangle, Bot, Smartphone, Image,
    Loader2, ChevronRight, CircleX, CircleAlert, CirclePause,
    SkipForward, Monitor, ListOrdered, Sparkles, KeyRound,
    Sun, Moon,
    Flame, GanttChart, Waves, Activity, Cpu, Calendar
} from 'lucide-react';

// Map string names to Lucide components
const ICON_MAP = {
    // Navigation
    'workflow': LayoutDashboard,
    'key': Key,
    'settings': Settings,
    'logout': LogOut,

    // Actions
    'copy': Copy,
    'trash': Trash2,
    'plus': Plus,
    'save': Save,
    'play': Play,
    'chevron-down': ChevronDown,
    'chevron-up': ChevronUp,
    'chevron-right': ChevronRight,
    'x': X,
    'search': Search,
    'pencil': Pencil,
    'refresh': RefreshCw,
    'link': Link,
    'send': Send,
    'arrow-left': ArrowLeft,
    'loader': Loader2,

    // Admin
    'bar-chart': BarChart3,
    'users': Users,
    'check-circle': CheckCircle2,
    'zap': Zap,
    'clapperboard': Clapperboard,
    'circle-check': CircleCheck,
    'trending-up': TrendingUp,
    'clock': Clock,
    'user-plus': UserPlus,
    'ban': Ban,
    'shield-check': ShieldCheck,

    // Node types
    'upload': Upload,
    'shuffle': Shuffle,
    'palette': Palette,
    'message-square': MessageSquare,
    'download': Download,
    'file-edit': FileEdit,
    'timer': Timer,
    'scissors': Scissors,
    'brain': Brain,
    'wrench': Wrench,
    'sparkles': Sparkles,

    // Files & Media
    'folder-open': FolderOpen,
    'package': Package,
    'camera': Camera,
    'paperclip': Paperclip,
    'file-up': FileUp,
    'file-text': FileText,
    'image': Image,
    'monitor': Monitor,

    // Auth & Status
    'mail': Mail,
    'mail-check': MailCheck,
    'alert-triangle': AlertTriangle,
    'bot': Bot,
    'smartphone': Smartphone,
    'key-round': KeyRound,
    'list-ordered': ListOrdered,

    // Status indicators
    'circle-x': CircleX,
    'circle-alert': CircleAlert,
    'circle-pause': CirclePause,
    'skip-forward': SkipForward,

    // Theme
    'sun': Sun,
    'moon': Moon,

    // Analytics
    'flame': Flame,
    'gantt-chart': GanttChart,
    'waves': Waves,
    'activity': Activity,
    'cpu': Cpu,
    'calendar': Calendar,
};

/**
 * Render a Lucide icon by name.
 * @param {object} props
 * @param {string} props.name - Icon name from ICON_MAP
 * @param {number} [props.size=18] - Icon size
 * @param {string} [props.className] - Additional CSS classes
 * @param {string} [props.color] - Icon color
 * @param {number} [props.strokeWidth] - Stroke width
 */
export function Icon({ name, size = 18, className = '', color, strokeWidth = 2, style, ...rest }) {
    const LucideIcon = ICON_MAP[name];
    if (!LucideIcon) {
        console.warn(`Icon "${name}" not found in ICON_MAP`);
        return <span style={{ width: size, height: size, display: 'inline-flex' }} />;
    }
    return (
        <LucideIcon
            size={size}
            className={className}
            color={color}
            strokeWidth={strokeWidth}
            style={style}
            {...rest}
        />
    );
}

export default Icon;
