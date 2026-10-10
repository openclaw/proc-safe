/* A real sd-bus peer for wire-layout, deadline, error, and ownership proof. */
#include <systemd/sd-bus.h>
#include <systemd/sd-id128.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/prctl.h>
#include <pthread.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct state { uint32_t count; };
static int no_auto_start(sd_bus_message *message, void *userdata, sd_bus_error *error) {
    (void)userdata; (void)error;
    uint8_t type;
    if (sd_bus_message_get_type(message, &type) < 0) return -EINVAL;
    if (type == SD_BUS_MESSAGE_METHOD_CALL && sd_bus_message_get_auto_start(message) != 0)
        return sd_bus_reply_method_errorf(message, SD_BUS_ERROR_ACCESS_DENIED, "auto-start must be disabled");
    return 0;
}
static int property(sd_bus *bus, const char *path, const char *interface, const char *name,
                    sd_bus_message *reply, void *userdata, sd_bus_error *error) {
    (void)bus; (void)path; (void)interface; (void)userdata; (void)error;
    if (!strcmp(name, "Text")) return sd_bus_message_append(reply, "s", "fixture");
    if (!strcmp(name, "Path")) return sd_bus_message_append(reply, "o", "/fixture");
    if (!strcmp(name, "Unsigned")) return sd_bus_message_append(reply, "u", UINT32_MAX);
    if (!strcmp(name, "Signed")) return sd_bus_message_append(reply, "i", INT32_MIN);
    if (!strcmp(name, "Big")) return sd_bus_message_append(reply, "t", UINT64_MAX);
    if (!strcmp(name, "Flag")) return sd_bus_message_append(reply, "b", 1);
    if (!strcmp(name, "Strings")) return sd_bus_message_append(reply, "as", 2, "", "two");
    if (!strcmp(name, "Condition")) return sd_bus_message_append(reply, "(sb)", "condition", 1);
    if (!strcmp(name, "Process")) return sd_bus_message_append(reply, "(sus)", "unit", UINT32_MAX, "process");
    if (!strcmp(name, "Exec")) return sd_bus_message_append(reply, "a(sasbttttuii)", 1,
        "/fixture", 2, "a", "b", 0, (uint64_t)1, (uint64_t)2, (uint64_t)3, UINT64_MAX, UINT32_MAX, INT32_MIN, INT32_MAX);
    return -ENOENT;
}
static int method(sd_bus_message *m, void *userdata, sd_bus_error *error) {
    struct state *state = userdata;
    const char *name = sd_bus_message_get_member(m);
    if (!strcmp(name, "Echo")) { const char *s; int r = sd_bus_message_read(m, "s", &s); return r < 0 ? r : sd_bus_reply_method_return(m, "s", s); }
    if (!strcmp(name, "Delay")) { uint32_t ms; int r = sd_bus_message_read(m, "u", &ms); if (r < 0) return r; usleep(ms * 1000); return sd_bus_reply_method_return(m, "s", "delayed"); }
    if (!strcmp(name, "Increment")) return sd_bus_reply_method_return(m, "u", ++state->count);
    if (!strcmp(name, "Count")) return sd_bus_reply_method_return(m, "u", state->count);
    if (!strcmp(name, "Flood")) {
        uint32_t count; int r = sd_bus_message_read(m, "u", &count);
        if (r < 0) return r;
        for (uint32_t i = 0; i < count; i++) {
            r = sd_bus_emit_signal(sd_bus_message_get_bus(m), "/fixture", "org.example.ProcSafe", "Pulse", "");
            if (r < 0) return r;
        }
        return sd_bus_reply_method_return(m, "u", count);
    }
    if (!strcmp(name, "Nothing")) return sd_bus_reply_method_return(m, "");
    if (!strcmp(name, "Big")) return sd_bus_reply_method_return(m, "t", UINT64_MAX);
    if (!strcmp(name, "Deny")) return sd_bus_error_set_const(error, SD_BUS_ERROR_ACCESS_DENIED, "denied");
    if (!strcmp(name, "Missing")) return sd_bus_error_set_const(error, "org.freedesktop.systemd1.NoSuchUnit", "missing");
    if (!strcmp(name, "Large")) { char value[2048]; memset(value, 'x', sizeof(value) - 1); value[sizeof(value) - 1] = 0; return sd_bus_reply_method_return(m, "s", value); }
    if (!strcmp(name, "Scalars")) {
        const char *s, *o; uint32_t u; int32_t i; uint64_t t; int b;
        int r = sd_bus_message_read(m, "souitb", &s, &o, &u, &i, &t, &b);
        if (r < 0) return r;
        if (strcmp(s, "value") || strcmp(o, "/fixture") || u != UINT32_MAX || i != INT32_MIN || t != UINT64_MAX || b != 1) return -EINVAL;
        return sd_bus_reply_method_return(m, "b", 1);
    }
    return -ENOSYS;
}
static const sd_bus_vtable vtable[] = {
    SD_BUS_VTABLE_START(0),
    SD_BUS_PROPERTY("Text", "s", property, 0, 0),
    SD_BUS_PROPERTY("Path", "o", property, 0, 0),
    SD_BUS_PROPERTY("Unsigned", "u", property, 0, 0),
    SD_BUS_PROPERTY("Signed", "i", property, 0, 0),
    SD_BUS_PROPERTY("Big", "t", property, 0, 0),
    SD_BUS_PROPERTY("Flag", "b", property, 0, 0),
    SD_BUS_PROPERTY("Strings", "as", property, 0, 0),
    SD_BUS_PROPERTY("Condition", "(sb)", property, 0, 0),
    SD_BUS_PROPERTY("Process", "(sus)", property, 0, 0),
    SD_BUS_PROPERTY("Exec", "a(sasbttttuii)", property, 0, 0),
    SD_BUS_METHOD("Echo", "s", "s", method, 0),
    SD_BUS_METHOD("Delay", "u", "s", method, 0),
    SD_BUS_METHOD("Increment", "", "u", method, 0),
    SD_BUS_METHOD("Count", "", "u", method, 0),
    SD_BUS_METHOD("Flood", "u", "u", method, 0),
    SD_BUS_METHOD("Nothing", "", "", method, 0),
    SD_BUS_METHOD("Big", "", "t", method, 0),
    SD_BUS_METHOD("Deny", "", "", method, 0),
    SD_BUS_METHOD("Missing", "", "", method, 0),
    SD_BUS_METHOD("Large", "", "s", method, 0),
    SD_BUS_METHOD("Scalars", "souitb", "b", method, 0),
    SD_BUS_VTABLE_END,
};
static void *serve(void *arg) {
    int fd = *(int *)arg; free(arg);
    sd_bus *bus = NULL;
    sd_id128_t id;
    struct state state = {0};
    if (sd_id128_randomize(&id) < 0 || sd_bus_new(&bus) < 0) { close(fd); return NULL; }
    if (sd_bus_set_fd(bus, fd, fd) < 0) { close(fd); goto done; }
    if (sd_bus_set_server(bus, 1, id) < 0 || sd_bus_add_filter(bus, NULL, no_auto_start, NULL) < 0 || sd_bus_add_object_vtable(bus, NULL, "/fixture", "org.example.ProcSafe", vtable, &state) < 0 || sd_bus_start(bus) < 0) goto done;
    for (;;) { int r = sd_bus_process(bus, NULL); if (r < 0) break; if (!r && sd_bus_wait(bus, UINT64_MAX) < 0) break; }
done:
    sd_bus_close_unref(bus);
    return NULL;
}
int main(int argc, char **argv) {
    if (argc != 2 || strlen(argv[1]) >= sizeof(((struct sockaddr_un *)0)->sun_path)) return 2;
    pid_t parent = getppid();
    if (prctl(PR_SET_PDEATHSIG, SIGTERM) < 0 || getppid() != parent) return 2;
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    strcpy(address.sun_path, argv[1]);
    if (fd < 0 || bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0 || listen(fd, 16) < 0) return 2;
    puts("READY"); fflush(stdout);
    for (;;) {
        int *client = malloc(sizeof(int));
        if (!client) return 2;
        *client = accept4(fd, NULL, NULL, SOCK_CLOEXEC);
        if (*client < 0) { free(client); if (errno == EINTR) continue; return 2; }
        pthread_t thread;
        if (pthread_create(&thread, NULL, serve, client)) { close(*client); free(client); return 2; }
        pthread_detach(thread);
    }
}
