#include "service_core.hpp"

int main(int argc, char* argv[]) {
    auto mode = noc::service::ServiceCore::Instance().ParseCommandLine(argc, argv);
    return noc::service::ServiceCore::Instance().Run(mode);
}
